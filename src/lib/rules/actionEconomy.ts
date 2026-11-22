import type { ActiveCharacterEffect } from '$lib/types/character';
import {
  FOLLOWUP_CLASSES,
  type ActionEconomyProfile,
  type ActionPoolDef,
  type FollowupClass,
  type FollowupState,
  type ProfileKey,
  type TurnCategory,
  type TurnLine,
  type TurnLogEntry,
  type TurnView
} from '$lib/types/actionEconomy';
import type { PoolMaxContext, PoolMaximum } from './cost';
import { sumTargetGrants } from './modifierGrants';

// ---------------------------------------------------------------------------------------------
// Profiles (built in, not DM-editable: the mapping is logic, not data)
// ---------------------------------------------------------------------------------------------

function pool(key: string, label: string, noun: (n: number) => string, base: number): ActionPoolDef {
  return { key, label, base, costLabel: (n) => `${n} ${noun(n)}` };
}
const plural = (word: string) => (n: number) => (n === 1 ? word : `${word}s`);

export const PROFILES: Record<ProfileKey, ActionEconomyProfile> = {
  dnd5e: {
    key: 'dnd5e',
    label: 'D&D 5e',
    description: 'Action, Bonus action and Reaction per turn.',
    pools: [
      pool('action', 'Action', plural('Action'), 1),
      pool('bonus_action', 'Bonus action', plural('Bonus action'), 1),
      pool('reaction', 'Reaction', plural('Reaction'), 1)
    ],
    // By timing only. Free and movement cost nothing.
    mapLine: ({ timing }) => (timing === 'action' || timing === 'bonus_action' || timing === 'reaction' ? timing : null)
  },
  attack_utility: {
    key: 'attack_utility',
    label: 'Attack & Utility (homebrew)',
    description: '2 Attack and 2 Utility actions per turn.',
    pools: [
      pool('attack', 'Attack', (n) => (n === 1 ? 'Attack action' : 'Attack actions'), 2),
      pool('utility', 'Utility', (n) => (n === 1 ? 'Utility action' : 'Utility actions'), 2)
    ],
    // By category only, so reactions and bonus actions draw on the same two pools. All spells and
    // cantrips count as Attack. Free and movement still cost nothing.
    mapLine: ({ timing, category }) => {
      if (timing === 'free' || timing === 'movement') return null;
      return category === 'general' ? 'utility' : 'attack';
    }
  }
};

// Unknown, null or missing means 5e (a campaign-less character, or a profile from the future).
export function profileFor(key: string | null | undefined): ActionEconomyProfile {
  return key !== null && key !== undefined && Object.hasOwn(PROFILES, key) ? PROFILES[key as ProfileKey] : PROFILES.dnd5e;
}

// The pool a line draws from: its own actionPool if the profile has it (the escape hatch), else the
// tag mapping. Null means free. A missing category reads as general. A free or movement line is
// free whatever its actionPool says (the hatch picks WHICH pool pays, never whether it costs).
export function resolveTurnPool(profile: ActionEconomyProfile, line: Pick<TurnLine, 'timing' | 'category' | 'actionPool'>): string | null {
  if (line.timing === 'free' || line.timing === 'movement') return null;
  if (line.actionPool && profile.pools.some((p) => p.key === line.actionPool)) return line.actionPool;
  return profile.mapLine({ timing: line.timing, category: line.category ?? 'general' });
}

// "1 Action", "2 Attack actions". An unknown pool key falls back to the raw key.
export function turnCostLabel(profile: ActionEconomyProfile, poolKey: string, n: number): string {
  const def = profile.pools.find((p) => p.key === poolKey);
  return def ? def.costLabel(n) : `${n} ${poolKey}`;
}

export function turnLineSummary(profile: ActionEconomyProfile, line: TurnLine): string {
  const key = resolveTurnPool(profile, line);
  return key === null ? 'Free' : turnCostLabel(profile, key, line.amount);
}

// The default category of a Container's turn line, from what is being activated.
export function inferCategory(contentType: string | null | undefined, activationKind?: string | null): TurnCategory {
  if (activationKind === 'weapon_attack') return 'attack';
  if (contentType === 'spell' || activationKind === 'spell' || activationKind === 'spell_access') return 'spell';
  return 'general';
}

// ---------------------------------------------------------------------------------------------
// Maxima and follow-ups (ordinary bonus/penalty modifiers, summed by count)
// ---------------------------------------------------------------------------------------------

// Per pool of the profile: base + every bonus - every penalty on action_pool.<key>.max, floored at
// 0. Pools the profile doesn't have are never read, so "Extra Attack action" does nothing in 5e.
export function actionPoolMaxima(
  profile: ActionEconomyProfile,
  sources: ActiveCharacterEffect[],
  ctx: PoolMaxContext = {}
): Record<string, PoolMaximum> {
  const result: Record<string, PoolMaximum> = {};
  for (const def of profile.pools) {
    const grants = sumTargetGrants(sources, `action_pool.${def.key}.max`, ctx.modifierContext ?? {});
    const lines = [{ label: 'Base', value: def.base }, ...grants];
    result[def.key] = { max: Math.max(0, lines.reduce((sum, line) => sum + line.value, 0)), lines };
  }
  return result;
}

// Free repeats per paid action of this attack type (Fighter 5/11/20 = 1+1+1), floored at 0.
export function followupCount(
  cls: FollowupClass,
  sources: ActiveCharacterEffect[],
  ctx: PoolMaxContext = {}
): { count: number; lines: Array<{ label: string; value: number }> } {
  const lines = sumTargetGrants(sources, `followup.${cls}.count`, ctx.modifierContext ?? {});
  return { count: Math.max(0, lines.reduce((sum, line) => sum + line.value, 0)), lines };
}

// ---------------------------------------------------------------------------------------------
// Turn state (what has been SPENT this turn, so a mid-turn max change applies at once)
// ---------------------------------------------------------------------------------------------

// A character_turn_state row as pg returns it. The json columns are untrusted until read.
export type TurnRow = { profile_key: string; turn_seq: number; spent_json: unknown; followups_json: unknown; log_json: unknown };
export type TurnRead = { turnSeq: number; spent: Record<string, number>; followups: Record<string, FollowupState>; log: TurnLogEntry[] };

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const count = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0);
const text = (value: unknown) => (typeof value === 'string' ? value : '');

// No row, or a row written under a different profile (the DM switched, or the character changed
// campaign), reads as a fresh turn: nothing spent, no follow-ups. The next write overwrites it.
export function readTurnRow(row: TurnRow | null | undefined, profileKey: ProfileKey): TurnRead {
  if (!row) return { turnSeq: 0, spent: {}, followups: {}, log: [] };
  const turnSeq = count(row.turn_seq);
  if (row.profile_key !== profileKey) return { turnSeq, spent: {}, followups: {}, log: [] };

  const spent: Record<string, number> = {};
  if (isRecord(row.spent_json)) for (const [key, value] of Object.entries(row.spent_json)) if (count(value) > 0) spent[key] = count(value);

  const followups: Record<string, FollowupState> = {};
  if (isRecord(row.followups_json)) {
    for (const cls of FOLLOWUP_CLASSES) {
      const raw = row.followups_json[cls];
      if (!isRecord(raw)) continue;
      const remaining = count(raw.remaining);
      if (remaining === 0) continue;
      const sources = Array.isArray(raw.sources) ? raw.sources.filter((s): s is string => typeof s === 'string') : [];
      followups[cls] = { remaining, sources, perAction: count(raw.perAction) };
    }
  }

  const log: TurnLogEntry[] = Array.isArray(row.log_json)
    ? row.log_json.filter(isRecord).map((entry) => ({
        pool: text(entry.pool), label: text(entry.label), amount: count(entry.amount), via: text(entry.via), source: text(entry.source), at: text(entry.at)
      }))
    : [];
  return { turnSeq, spent, followups, log };
}

// The button label. The granting feature can name it later; "Extra Attack" is the default.
export function followupLabel(_cls: FollowupClass): string {
  return 'Extra Attack';
}

// What the sheet and the VTT show: remaining = max(0, liveMax - spent) per pool, plus the follow-ups
// still waiting. followupInfo is the live per-action count (it can differ from what was stored).
export function buildTurnView(
  profile: ActionEconomyProfile,
  read: TurnRead,
  maxima: Record<string, PoolMaximum>,
  followupInfo: Partial<Record<FollowupClass, { count: number }>> = {}
): TurnView {
  return {
    profileKey: profile.key,
    profileLabel: profile.label,
    turnSeq: read.turnSeq,
    pools: profile.pools.map((def) => {
      const max = maxima[def.key]?.max ?? def.base;
      const spent = read.spent[def.key] ?? 0;
      return {
        key: def.key, label: def.label, max, spent, current: Math.max(0, max - spent),
        breakdown: maxima[def.key]?.lines ?? [{ label: 'Base', value: def.base }]
      };
    }),
    followups: FOLLOWUP_CLASSES.flatMap((cls) => {
      const state = read.followups[cls];
      if (!state || state.remaining <= 0) return [];
      return [{ cls, label: followupLabel(cls), remaining: state.remaining, perAction: followupInfo[cls]?.count ?? state.perAction }];
    }),
    log: read.log.map(({ label, pool, amount, via, at }) => ({ label, pool, amount, via, at }))
  };
}
