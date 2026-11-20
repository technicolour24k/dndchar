import { sessions } from '$vtt/store.js';
import { abilityMap, abilityModifier } from '$lib/rules/dnd5e';
import { characterStatsFor } from '$lib/rules/characterStats';
import { poolSummary, previewAdvantage, rollWithModifiers, type AdvantageSource } from '$lib/rules/attackRoll';
import { findSkill, skillCandidates, skillCheckBonus } from '$lib/rules/skills';
import { getCharacterForRoll } from '$lib/server/services/characters';
import { logRoll } from '$lib/server/services/rollLog';
import { gatherVttAdvantageSources, parseAttackOptions } from '$lib/server/vttAttackAdvantage';
import type { ForageCheck } from '$lib/types/forage';

// The server-side forage skill check, shared by the DM's "check" action and a self-serve "start".
// The client only sends its CHOICES (skill, unticked sources, situational counters). Every source is
// recomputed here from live data, through the same gatherVttAdvantageSources and rollWithModifiers
// the VTT's attack rolls use, so advantage/disadvantage (conditions, the manual counters) apply.
//
// Deliberately NOT owner-scoped (getCharacterForRoll): a GM rolling for a player's character is a
// pure dice read, the same posture as roll-attack. Who may trigger it is decided by the endpoint.

export class ForageRollError extends Error {
  constructor(public code: 'bad_skill' | 'character_not_found') {
    super(code);
  }
}

type RollInput = {
  characterId: string;
  skillKey: string;
  /** The character's own token in the room, if any (its conditions feed the roll). */
  token: { id: string } | null;
  sessionId: string | null;
  /** The request body, for parseAttackOptions: { advantage: { disabled, situationalAdvantage, ... } }. */
  body: unknown;
  rollDie?: (sides: number) => number;
};

async function prepare(input: RollInput) {
  const skill = findSkill(input.skillKey);
  if (!skill) throw new ForageRollError('bad_skill');
  const character = await getCharacterForRoll(input.characterId);
  if (!character) throw new ForageRollError('character_not_found');

  const options = parseAttackOptions(input.body);
  const candidates = skillCandidates(skill);
  const context = { classes: character.classes, ability: skill.ability };
  const gathered = await gatherVttAdvantageSources({
    vtt: input.token && input.sessionId ? { sessionId: input.sessionId, sourceTokenId: input.token.id, targetTokenId: null } : null,
    attackerSources: character.modifierSources,
    attackerCandidates: candidates,
    targetCandidates: [],
    context,
    choices: options
  });

  // characterStatsFor resolves the proficiency override cascade the same way the sheet does.
  const abilityScores = abilityMap(character.abilities);
  const proficient = character.proficiencies.skills.includes(skill.key);
  const proficiencyBonus = characterStatsFor(character).proficiency.value;
  const bonus = skillCheckBonus({
    abilityScores,
    proficient,
    proficiencyBonus,
    modifierSources: character.modifierSources,
    classes: character.classes
  }, skill);

  // Source-attributed pieces of the bonus, for the roll's audit text.
  const breakdown = [
    { label: `${skill.ability.toUpperCase()} modifier`, value: abilityModifier(abilityScores[skill.ability]) },
    ...(proficient ? [{ label: 'Proficiency', value: proficiencyBonus }] : []),
    ...bonus.bonuses
  ];

  return { skill, character, options, candidates, context, gathered, bonus, breakdown };
}

/** Sources and net pool for the player's or GM's popup, without rolling anything. */
export async function previewForageAdvantage(input: RollInput): Promise<{ sources: AdvantageSource[]; pool: unknown; skillLabel: string; bonus: number }> {
  const { skill, character, options, candidates, context, gathered, bonus } = await prepare(input);
  const preview = previewAdvantage(character.modifierSources, candidates, context, gathered.extraSources, options.disabledSourceIds);
  return { sources: preview.sources, pool: preview.pool, skillLabel: skill.name, bonus: bonus.total };
}

/**
 * The player's popup in DM mode, before the DM has called any skill. Only sources that apply to every
 * ability check (targets like ability_check.all) can be known, so that's all it shows. There is no
 * ability context here either, so conditional sources may differ from the DM's real roll. The real roll
 * (the DM's chosen skill) still applies every source server-side. Reveals no skill, table or bonus.
 */
export async function previewGenericAdvantage(input: Omit<RollInput, 'skillKey' | 'rollDie'>): Promise<{ sources: AdvantageSource[]; pool: unknown }> {
  const character = await getCharacterForRoll(input.characterId);
  if (!character) throw new ForageRollError('character_not_found');
  const options = parseAttackOptions(input.body);
  const candidates = ['ability_check.any'];
  const context = { classes: character.classes };
  const gathered = await gatherVttAdvantageSources({
    vtt: input.token && input.sessionId ? { sessionId: input.sessionId, sourceTokenId: input.token.id, targetTokenId: null } : null,
    attackerSources: character.modifierSources, attackerCandidates: candidates, targetCandidates: [], context, choices: options
  });
  const preview = previewAdvantage(character.modifierSources, candidates, context, gathered.extraSources, options.disabledSourceIds);
  return { sources: preview.sources, pool: preview.pool };
}

/** Rolls the skill check. nat20/nat1 come from the KEPT die (after any advantage pool). */
export async function rollForageCheck(input: RollInput): Promise<ForageCheck> {
  const { skill, character, options, candidates, context, gathered, bonus, breakdown } = await prepare(input);
  const rolled = rollWithModifiers(
    character.modifierSources, bonus.total, candidates, breakdown, input.rollDie,
    { flatModifiersIncluded: true, context, extraAdvantageSources: gathered.extraSources, disabledSourceIds: options.disabledSourceIds }
  );
  return {
    skillKey: skill.key,
    skillLabel: skill.name,
    total: rolled.total,
    natural: rolled.natural,
    nat20: rolled.natural === 20,
    nat1: rolled.natural === 1,
    text: rolled.text,
    poolSummary: poolSummary(rolled.pool)
  };
}

/**
 * Posts a public roll-log line, only when the forage's room is live. The roll-log GET is role-blind,
 * so the message and details must never carry item names or ids (callers pass the redacted wording).
 */
export async function logForageRoll(roomCode: string | null, message: string, details: Record<string, unknown>): Promise<void> {
  if (!roomCode || !sessions.has(roomCode)) return;
  try {
    await logRoll(roomCode, message, details, 'public');
  } catch (error) {
    // A log failure must never undo a haul that has already been committed.
    console.error('[forage] could not write the roll-log line', error);
  }
}

/** The `details` object for forage roll-log lines. No item ids or names. */
export function forageLogDetails(input: {
  check: ForageCheck; outcome: 'failed' | 'found'; mode: 'dm' | 'self'; itemCount: number; findId?: string;
}): Record<string, unknown> {
  return {
    kind: 'forage', skill: input.check.skillKey, total: input.check.total, natural: input.check.natural,
    pool: input.check.poolSummary, outcome: input.outcome, mode: input.mode, itemCount: input.itemCount,
    ...(input.findId ? { findId: input.findId } : {})
  };
}
