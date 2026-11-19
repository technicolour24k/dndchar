import { sessions } from '$vtt/store.js';
import type { ActiveCharacterEffect } from '$lib/types/character';
import type { ModifierContext } from '$lib/rules/dnd5e';
import {
  collectAdvantageSources,
  situationalAdvantageSources,
  type AdvantageSource,
  type RollChoices
} from '$lib/rules/attackRoll';
import { resolveCharacterModifierSources } from '$lib/server/services/rule-engine';
import { loadVttConditionEffects } from '$lib/server/services/vttConditions';

// Server-side helpers for the VTT's advantage/disadvantage flow. The client only sends its
// CHOICES (which sources to switch off, the situational counts, the damage-dice delta). Every
// source itself is recomputed here from live data, so the client can't invent a source.

export type VttRef = { sessionId: string; sourceTokenId: string; targetTokenId: string | null };

export type ParsedAttackOptions = RollChoices & { vtt: VttRef | null; preview: boolean };

function clamp(value: unknown, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(Number(value) || 0)));
}

function shortString(value: unknown, max = 200): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

// Shape of the optional body additions (all optional, so an old request behaves as today):
//   { preview?, vtt?: { sessionId, sourceTokenId, targetTokenId }, advantage?: { disabled?,
//     situationalAdvantage?, situationalDisadvantage? }, manualDamageDice? }
export function parseAttackOptions(body: unknown): ParsedAttackOptions {
  const input = (body && typeof body === 'object' ? body : {}) as Record<string, any>;

  const vttInput = input.vtt && typeof input.vtt === 'object' ? input.vtt : null;
  const sessionId = shortString(vttInput?.sessionId);
  const sourceTokenId = shortString(vttInput?.sourceTokenId);
  const vtt: VttRef | null = sessionId && sourceTokenId
    ? { sessionId, sourceTokenId, targetTokenId: shortString(vttInput?.targetTokenId) }
    : null;

  const advantage = input.advantage && typeof input.advantage === 'object' ? input.advantage : {};
  // Strings only, at most 50 ids of 200 characters or fewer.
  const disabledSourceIds = Array.isArray(advantage.disabled)
    ? advantage.disabled.filter((id: unknown): id is string => typeof id === 'string' && id.length <= 200).slice(0, 50)
    : [];

  return {
    vtt,
    preview: input.preview === true,
    disabledSourceIds,
    situationalAdvantage: clamp(advantage.situationalAdvantage, 0, 5),
    situationalDisadvantage: clamp(advantage.situationalDisadvantage, 0, 5),
    // INTERIM: manual damage-dice delta.
    manualDamageDice: clamp(input.manualDamageDice, -5, 5)
  };
}

// Chebyshev squares x 5 ft (a diagonal counts as one square), rounded to the nearest square.
function distanceBetweenTokensFt(attacker: any, target: any, gridSizePx: number): number | undefined {
  if (![attacker?.x, attacker?.y, target?.x, target?.y].every((n) => Number.isFinite(n))) return undefined;
  const px = Math.max(Math.abs(attacker.x - target.x), Math.abs(attacker.y - target.y));
  return Math.round(px / gridSizePx) * 5;
}

export type GatherArgs = {
  vtt: VttRef | null;
  // The attacker's own sheet sources (empty for a monster). Used to dedupe token conditions that
  // are also active on the sheet, so the same Container never counts twice.
  attackerSources: ActiveCharacterEffect[];
  attackerCandidates: string[];
  targetCandidates: string[];
  context: ModifierContext;
  choices: Pick<RollChoices, 'situationalAdvantage' | 'situationalDisadvantage'>;
};

// Builds every non-attacker-sheet source: attacker token conditions, target sheet modifiers,
// target token conditions, then the manual situational counters. Also returns the token distance
// so the caller can pass it into the roll's context (it gates e.g. Prone's within/beyond 5 ft).
export async function gatherVttAdvantageSources(args: GatherArgs): Promise<{ extraSources: AdvantageSource[]; distanceFt?: number }> {
  const situational = situationalAdvantageSources(args.choices.situationalAdvantage, args.choices.situationalDisadvantage);
  // A failed condition/target load (DB hiccup) must never block a roll or, worse, a spell cast, so
  // it falls back to the situational sources only.
  try {
    return await gatherVttAdvantageSourcesUnsafe(args, situational);
  } catch (error) {
    console.error('[VTT] could not gather advantage sources, using situational only', error);
    return { extraSources: situational };
  }
}

async function gatherVttAdvantageSourcesUnsafe(
  args: GatherArgs,
  situational: AdvantageSource[]
): Promise<{ extraSources: AdvantageSource[]; distanceFt?: number }> {
  const session = args.vtt ? sessions.get(args.vtt.sessionId) : undefined;
  if (!args.vtt || !session) return { extraSources: situational };

  const attackerToken = session.tokens?.[args.vtt.sourceTokenId];
  const targetToken = args.vtt.targetTokenId ? session.tokens?.[args.vtt.targetTokenId] : undefined;
  const gridSizePx = Number(session.map?.gridSizePx) > 0 ? Number(session.map.gridSizePx) : 50;
  const distanceFt = attackerToken && targetToken ? distanceBetweenTokensFt(attackerToken, targetToken, gridSizePx) : undefined;
  const context: ModifierContext = { ...args.context, distanceFt };

  const conditionEffects = await loadVttConditionEffects();
  const conditionsFor = (token: any, alreadyActive: ActiveCharacterEffect[]) => {
    const present = new Set(alreadyActive.map((source) => source.containerKey).filter(Boolean));
    const keys: string[] = Array.isArray(token?.conditions) ? token.conditions : [];
    return keys
      .map((key) => conditionEffects.get(key))
      .filter((effect): effect is ActiveCharacterEffect => !!effect && !present.has(effect.containerKey));
  };

  const extraSources: AdvantageSource[] = [];

  // Attacker token conditions (e.g. Poisoned, Invisible), skipping any already on the sheet.
  extraSources.push(...collectAdvantageSources(
    conditionsFor(attackerToken, args.attackerSources), args.attackerCandidates, context, 'attacker_condition'
  ));

  // Target: its sheet modifiers (e.g. Dodge) when the token is linked to a character, then its
  // token conditions, deduped against that sheet.
  let targetSheet: ActiveCharacterEffect[] = [];
  if (typeof targetToken?.characterId === 'string' && targetToken.characterId) {
    targetSheet = (await resolveCharacterModifierSources(targetToken.characterId)).sources;
    extraSources.push(...collectAdvantageSources(targetSheet, args.targetCandidates, context, 'target'));
  }
  extraSources.push(...collectAdvantageSources(
    conditionsFor(targetToken, targetSheet), args.targetCandidates, context, 'target_condition'
  ));

  return { extraSources: [...extraSources, ...situational], distanceFt };
}
