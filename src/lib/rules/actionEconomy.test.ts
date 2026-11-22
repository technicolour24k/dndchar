import { describe, expect, it } from 'vitest';
import type { ActiveCharacterEffect, EffectModifier } from '$lib/types/character';
import type { TurnCategory, TurnTiming } from '$lib/types/actionEconomy';
import {
  PROFILES,
  actionPoolMaxima,
  buildTurnView,
  followupCount,
  inferCategory,
  profileFor,
  readTurnRow,
  resolveTurnPool,
  turnCostLabel,
  turnLineSummary,
  type TurnRow
} from './actionEconomy';
import { castingTimeActionLine, defaultCostFor, effectiveCost, parseCostJson, withCategory } from './cost';

function mod(target: string, modifierType: string, valueExpression: string, conditionExpression = ''): EffectModifier {
  return { target, modifierType, label: '', valueExpression, defaultValueExpression: valueExpression, valueOverrideExpression: '', conditionExpression, priority: 0 };
}
function source(name: string, modifiers: EffectModifier[]): ActiveCharacterEffect {
  return {
    id: name, effectId: name, effectKey: name, name, sourceType: 'feat', sourceName: name, description: '',
    durationType: 'permanent', requiresConcentration: false, isCondition: false, isSelectable: false, remainingRounds: null, modifiers
  };
}

const dnd5e = PROFILES.dnd5e;
const homebrew = PROFILES.attack_utility;
const map = (profile: typeof dnd5e, timing: TurnTiming, category: TurnCategory) => profile.mapLine({ timing, category });
const TIMINGS: TurnTiming[] = ['action', 'bonus_action', 'reaction', 'movement', 'free'];
const CATEGORIES: TurnCategory[] = ['attack', 'spell', 'general'];

describe('profiles', () => {
  it('5e has Action / Bonus action / Reaction at 1 each', () => {
    expect(dnd5e.pools.map((p) => [p.key, p.base])).toEqual([['action', 1], ['bonus_action', 1], ['reaction', 1]]);
  });
  it('homebrew has Attack / Utility at 2 each', () => {
    expect(homebrew.pools.map((p) => [p.key, p.base])).toEqual([['attack', 2], ['utility', 2]]);
  });
  it('5e maps by timing only, whatever the category', () => {
    for (const category of CATEGORIES) {
      expect(map(dnd5e, 'action', category)).toBe('action');
      expect(map(dnd5e, 'bonus_action', category)).toBe('bonus_action');
      expect(map(dnd5e, 'reaction', category)).toBe('reaction');
      expect(map(dnd5e, 'free', category)).toBeNull();
      expect(map(dnd5e, 'movement', category)).toBeNull();
    }
  });
  it('homebrew maps by category only: attack and spell to Attack, general to Utility, timing ignored', () => {
    for (const timing of ['action', 'bonus_action', 'reaction'] as const) {
      expect(map(homebrew, timing, 'attack')).toBe('attack');
      expect(map(homebrew, timing, 'spell')).toBe('attack');
      expect(map(homebrew, timing, 'general')).toBe('utility');
    }
  });
  it('homebrew free and movement cost nothing, in every category', () => {
    for (const category of CATEGORIES) {
      expect(map(homebrew, 'free', category)).toBeNull();
      expect(map(homebrew, 'movement', category)).toBeNull();
    }
  });
  it('every mapping lands on a pool the profile has (or null)', () => {
    for (const profile of [dnd5e, homebrew]) {
      for (const timing of TIMINGS) for (const category of CATEGORIES) {
        const key = map(profile, timing, category);
        if (key !== null) expect(profile.pools.map((p) => p.key)).toContain(key);
      }
    }
  });
  it('profileFor falls back to 5e for null, undefined and unknown keys', () => {
    expect(profileFor('attack_utility')).toBe(homebrew);
    expect(profileFor('dnd5e')).toBe(dnd5e);
    for (const key of [null, undefined, '', 'nonsense', 'constructor', '__proto__']) expect(profileFor(key)).toBe(dnd5e);
  });
});

describe('labels', () => {
  it('5e cost labels', () => {
    expect([1, 2].map((n) => turnCostLabel(dnd5e, 'action', n))).toEqual(['1 Action', '2 Actions']);
    expect([1, 2].map((n) => turnCostLabel(dnd5e, 'bonus_action', n))).toEqual(['1 Bonus action', '2 Bonus actions']);
    expect([1, 2].map((n) => turnCostLabel(dnd5e, 'reaction', n))).toEqual(['1 Reaction', '2 Reactions']);
  });
  it('homebrew cost labels', () => {
    expect([1, 2].map((n) => turnCostLabel(homebrew, 'attack', n))).toEqual(['1 Attack action', '2 Attack actions']);
    expect([1, 2].map((n) => turnCostLabel(homebrew, 'utility', n))).toEqual(['1 Utility action', '2 Utility actions']);
  });
  it('an unknown pool key falls back to the raw key', () => {
    expect(turnCostLabel(dnd5e, 'utility', 1)).toBe('1 utility');
  });
  it('the same Fireball line labels "1 Action" in 5e and "1 Attack action" in homebrew', () => {
    const line = { pool: 'turn', amount: 1, timing: 'action', category: 'spell' } as const;
    expect(turnLineSummary(dnd5e, line)).toBe('1 Action');
    expect(turnLineSummary(homebrew, line)).toBe('1 Attack action');
  });
  it('turnLineSummary says Free for a free line', () => {
    expect(turnLineSummary(dnd5e, { pool: 'turn', amount: 1, timing: 'free' })).toBe('Free');
    expect(turnLineSummary(homebrew, { pool: 'turn', amount: 1, timing: 'movement', category: 'general' })).toBe('Free');
  });
});

describe('the spec examples, end to end through parse, defaults and mapping', () => {
  // The line a spell resolves to with cost_json NULL, mapped through a profile.
  const spell = (castingTime: string, profile: typeof dnd5e, level = 0) =>
    turnLineSummary(profile, withCategory(defaultCostFor({ contentType: 'spell', spellLevel: level, castingTime }), 'spell').find((e) => e.pool === 'turn') as never);

  it('5e: cantrip Fire Bolt is 1 Action', () => {
    expect(spell('1 action', dnd5e)).toBe('1 Action');
  });
  it('5e: Shield ("1 reaction, which you take...") is a Reaction', () => {
    expect(spell('1 reaction, which you take when you are hit by an attack', dnd5e, 1)).toBe('1 Reaction');
  });
  it('5e: a bonus action spell is a Bonus action', () => {
    expect(spell('1 bonus action', dnd5e, 2)).toBe('1 Bonus action');
  });
  it('5e: a free line is Free', () => {
    const [free] = parseCostJson([{ pool: 'turn', amount: 1, timing: 'free' }]).entries!;
    expect(turnLineSummary(dnd5e, free as never)).toBe('Free');
  });
  it('homebrew: Fireball, Bless, Misty Step (bonus action) and Shield (reaction) all cost Attack', () => {
    for (const [time, level] of [['1 action', 3], ['1 action', 1], ['1 bonus action', 2], ['1 reaction, which you take when hit', 1]] as const) {
      expect(spell(time, homebrew, level)).toBe('1 Attack action');
    }
  });
  it('homebrew: all cantrips cost Attack too', () => {
    expect(spell('1 action', homebrew, 0)).toBe('1 Attack action');
  });
  it('homebrew: a potion (general) costs Utility', () => {
    const potion = withCategory(defaultCostFor({ contentType: 'item', isItemUse: true, includeUseAction: true }), 'general').find((e) => e.pool === 'turn')!;
    expect(turnLineSummary(homebrew, potion as never)).toBe('1 Utility action');
    expect(turnLineSummary(dnd5e, potion as never)).toBe('1 Action');
  });
  it('homebrew: a weapon attack costs Attack, and 5e maps its timing', () => {
    for (const [timing, key] of [['action', 'action'], ['bonus_action', 'bonus_action'], ['reaction', 'reaction']] as const) {
      const [line] = defaultCostFor({ contentType: 'item', activationKind: 'weapon_attack', weaponTiming: timing });
      expect(resolveTurnPool(homebrew, line as never)).toBe('attack');
      expect(resolveTurnPool(dnd5e, line as never)).toBe(key);
    }
  });
  it('a dash is 1 Action in 5e and 1 Utility in homebrew, no special casing', () => {
    const [dash] = defaultCostFor({ contentType: 'item', activationKind: 'dash', dashCount: 2 });
    expect(turnLineSummary(dnd5e, dash as never)).toBe('2 Actions');
    expect(turnLineSummary(homebrew, dash as never)).toBe('2 Utility actions');
  });
  it('a casting time that gives no turn line stays free of one', () => {
    expect(castingTimeActionLine('1 minute')).toBeNull();
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 0, castingTime: '1 minute' })).toEqual([]);
  });
  it('legacy display-only lines convert and take the container category', () => {
    const parsed = parseCostJson([{ pool: 'bonus_action', amount: 1 }]).entries!;
    const [line] = withCategory(parsed, inferCategory('spell'));
    expect(line).toEqual({ pool: 'turn', amount: 1, timing: 'bonus_action', category: 'spell' });
    expect(turnLineSummary(homebrew, line as never)).toBe('1 Attack action');
  });
  it('inheritance: an explicit [] on a spell still has its turn line, an explicit free line does not', () => {
    const defaults = defaultCostFor({ contentType: 'spell', spellLevel: 1, castingTime: '1 action' });
    const inherited = effectiveCost([], defaults);
    expect(inherited).toEqual([{ pool: 'turn', amount: 1, timing: 'action', category: 'spell' }]);
    const free = effectiveCost(parseCostJson([{ pool: 'turn', amount: 1, timing: 'free' }]).entries, defaults);
    expect(turnLineSummary(dnd5e, free[0] as never)).toBe('Free');
  });
});

describe('resolveTurnPool', () => {
  it('actionPool wins when the profile has it', () => {
    expect(resolveTurnPool(homebrew, { timing: 'action', category: 'spell', actionPool: 'utility' })).toBe('utility');
    expect(resolveTurnPool(dnd5e, { timing: 'bonus_action', actionPool: 'reaction' })).toBe('reaction');
  });
  it('free and movement lines stay free whatever their actionPool says', () => {
    for (const timing of ['free', 'movement'] as const) {
      expect(resolveTurnPool(dnd5e, { timing, actionPool: 'action' })).toBeNull();
      expect(resolveTurnPool(homebrew, { timing, category: 'attack', actionPool: 'utility' })).toBeNull();
    }
  });
  it('falls back to the tag mapping when the profile lacks the pool', () => {
    expect(resolveTurnPool(dnd5e, { timing: 'action', category: 'general', actionPool: 'utility' })).toBe('action');
    expect(resolveTurnPool(homebrew, { timing: 'bonus_action', category: 'spell', actionPool: 'bonus_action' })).toBe('attack');
  });
  it('an unknown actionPool is ignored, and a missing category reads as general', () => {
    expect(resolveTurnPool(homebrew, { timing: 'action', actionPool: 'mana' })).toBe('utility');
  });
});

describe('inferCategory', () => {
  it('weapon attacks are attack, spells are spell, everything else general', () => {
    expect(inferCategory('item', 'weapon_attack')).toBe('attack');
    expect(inferCategory('spell')).toBe('spell');
    expect(inferCategory('item', 'spell_access')).toBe('spell');
    expect(inferCategory('spell', 'spell')).toBe('spell');
    for (const type of ['item', 'feat', 'class_feature', 'condition', null, undefined]) expect(inferCategory(type)).toBe('general');
    expect(inferCategory('item', 'dash')).toBe('general');
  });
});

describe('actionPoolMaxima', () => {
  it('is the base with no sources', () => {
    expect(actionPoolMaxima(homebrew, []).attack).toEqual({ max: 2, lines: [{ label: 'Base', value: 2 }] });
    expect(Object.keys(actionPoolMaxima(dnd5e, []))).toEqual(['action', 'bonus_action', 'reaction']);
  });
  it('+1 Attack from an item plus +1 from a feat gives 4, labelled by source', () => {
    const out = actionPoolMaxima(homebrew, [
      source('Ring of Haste', [mod('action_pool.attack.max', 'bonus', '1')]),
      source('Fast Hands', [mod('action_pool.attack.max', 'bonus', '1')])
    ]);
    expect(out.attack.max).toBe(4);
    expect(out.attack.lines).toEqual([{ label: 'Base', value: 2 }, { label: 'Ring of Haste', value: 1 }, { label: 'Fast Hands', value: 1 }]);
    expect(out.utility.max).toBe(2);
  });
  it('subtracts penalties and floors at 0', () => {
    const out = actionPoolMaxima(homebrew, [source('Slowed', [mod('action_pool.attack.max', 'penalty', '5')])]);
    expect(out.attack.max).toBe(0);
    expect(out.attack.lines).toEqual([{ label: 'Base', value: 2 }, { label: 'Slowed', value: -5 }]);
  });
  it('ignores a conditional bonus whose condition does not hold, and applies it when it does', () => {
    const sources = [source('Action Surge', [mod('action_pool.action.max', 'bonus', '1', 'flag:surging')])];
    expect(actionPoolMaxima(dnd5e, sources).action.max).toBe(1);
    expect(actionPoolMaxima(dnd5e, sources, { modifierContext: { flags: ['surging'] } }).action.max).toBe(2);
  });
  it('an Extra Attack action bonus does nothing in 5e', () => {
    const sources = [source('Ring', [mod('action_pool.attack.max', 'bonus', '1')])];
    const out = actionPoolMaxima(dnd5e, sources);
    expect(out.attack).toBeUndefined();
    expect(Object.values(out).map((p) => p.max)).toEqual([1, 1, 1]);
  });
  it('a bonus aimed at 5e Action does nothing in homebrew', () => {
    const out = actionPoolMaxima(homebrew, [source('Surge', [mod('action_pool.action.max', 'bonus', '1')])]);
    expect(out.attack.max).toBe(2);
    expect(out.utility.max).toBe(2);
  });
});

describe('followupCount', () => {
  it('sums 1+1+1 = 3 for Fighter 5/11/20', () => {
    const sources = ['Extra Attack', 'Extra Attack (2)', 'Extra Attack (3)'].map((name) => source(name, [mod('followup.melee.count', 'bonus', '1')]));
    const out = followupCount('melee', sources);
    expect(out.count).toBe(3);
    expect(out.lines.map((l) => l.label)).toEqual(['Extra Attack', 'Extra Attack (2)', 'Extra Attack (3)']);
  });
  it('is keyed by attack type: Extra Attack grants melee and ranged, a doublecast grants spell only', () => {
    const extra = source('Extra Attack', [mod('followup.melee.count', 'bonus', '1'), mod('followup.ranged.count', 'bonus', '1')]);
    const echo = source('Echo', [mod('followup.spell.count', 'bonus', '1')]);
    const counts = (srcs: ActiveCharacterEffect[]) => (['melee', 'ranged', 'spell', 'cantrip', 'other'] as const).map((cls) => followupCount(cls, srcs).count);
    expect(counts([extra])).toEqual([1, 1, 0, 0, 0]);
    expect(counts([extra, echo])).toEqual([1, 1, 1, 0, 0]);
    expect(counts([source('Cantrip echo', [mod('followup.cantrip.count', 'bonus', '2')])])).toEqual([0, 0, 0, 2, 0]);
  });
  it('is 0 with nothing, floors at 0, and respects conditions', () => {
    expect(followupCount('melee', []).count).toBe(0);
    expect(followupCount('melee', [source('Crippled', [mod('followup.melee.count', 'penalty', '2')])]).count).toBe(0);
    const net = followupCount('melee', [
      source('A', [mod('followup.melee.count', 'bonus', '3')]),
      source('B', [mod('followup.melee.count', 'penalty', '1')])
    ]);
    expect(net.count).toBe(2);
    const gated = [source('Haste', [mod('followup.melee.count', 'bonus', '1', 'flag:hasted')])];
    expect(followupCount('melee', gated).count).toBe(0);
    expect(followupCount('melee', gated, { modifierContext: { flags: ['hasted'] } }).count).toBe(1);
  });
  it('ignores other targets, including the pool maxima', () => {
    expect(followupCount('melee', [source('Ring', [mod('action_pool.attack.max', 'bonus', '1')])]).count).toBe(0);
  });
});

describe('readTurnRow', () => {
  const row = (over: Partial<TurnRow> = {}): TurnRow => ({
    profile_key: 'attack_utility', turn_seq: 4, spent_json: { attack: 1 },
    followups_json: { melee: { remaining: 2, sources: ['Extra Attack'], perAction: 2 } },
    log_json: [{ pool: 'attack', label: 'Fireball', amount: 1, via: 'pool', source: 'Fireball', at: '2026-11-22T10:00:00Z' }], ...over
  });
  it('no row reads as a fresh turn', () => {
    expect(readTurnRow(null, 'dnd5e')).toEqual({ turnSeq: 0, spent: {}, followups: {}, log: [] });
    expect(readTurnRow(undefined, 'dnd5e')).toEqual({ turnSeq: 0, spent: {}, followups: {}, log: [] });
  });
  it('a matching profile reads the row', () => {
    const read = readTurnRow(row(), 'attack_utility');
    expect(read.turnSeq).toBe(4);
    expect(read.spent).toEqual({ attack: 1 });
    expect(read.followups).toEqual({ melee: { remaining: 2, sources: ['Extra Attack'], perAction: 2 } });
    expect(read.log).toHaveLength(1);
  });
  it('a mismatched profile reads as nothing spent and no follow-ups, keeping the turn number', () => {
    expect(readTurnRow(row(), 'dnd5e')).toEqual({ turnSeq: 4, spent: {}, followups: {}, log: [] });
  });
  it('survives malformed json instead of throwing', () => {
    const read = readTurnRow(row({ spent_json: [1, 2], followups_json: 'x', log_json: { a: 1 }, turn_seq: -3 }), 'attack_utility');
    expect(read).toEqual({ turnSeq: 0, spent: {}, followups: {}, log: [] });
    const messy = readTurnRow(row({
      spent_json: { attack: -2, utility: 'many', ok: 1.9 },
      followups_json: { melee: { remaining: 0 }, bogus: { remaining: 3 } },
      log_json: [null, 5, { label: 7 }]
    }), 'attack_utility');
    expect(messy.spent).toEqual({ ok: 1 });
    expect(messy.followups).toEqual({});
    expect(messy.log).toEqual([{ pool: '', label: '', amount: 0, via: '', source: '', at: '' }]);
  });
  it('drops follow-up classes it does not know and tolerates missing sources', () => {
    const read = readTurnRow(row({ followups_json: { melee: { remaining: 1 }, bogus: { remaining: 2 } } }), 'attack_utility');
    expect(read.followups).toEqual({ melee: { remaining: 1, sources: [], perAction: 0 } });
  });
});

describe('buildTurnView', () => {
  const noRow = readTurnRow(null, 'attack_utility');
  it('a fresh turn is full, with base breakdowns', () => {
    const view = buildTurnView(homebrew, noRow, actionPoolMaxima(homebrew, []));
    expect(view.profileKey).toBe('attack_utility');
    expect(view.profileLabel).toBe(homebrew.label);
    expect(view.pools.map((p) => [p.key, p.label, p.current, p.max, p.spent])).toEqual([['attack', 'Attack', 2, 2, 0], ['utility', 'Utility', 2, 2, 0]]);
    expect(view.followups).toEqual([]);
    expect(view.log).toEqual([]);
  });
  it('remaining is max(0, liveMax - spent), so a mid-turn max change applies at once', () => {
    const read = { ...noRow, spent: { attack: 3 } };
    const ring = [source('Ring', [mod('action_pool.attack.max', 'bonus', '1')])];
    expect(buildTurnView(homebrew, read, actionPoolMaxima(homebrew, ring)).pools[0]).toMatchObject({ current: 0, max: 3, spent: 3 });
    expect(buildTurnView(homebrew, { ...noRow, spent: { attack: 1 } }, actionPoolMaxima(homebrew, ring)).pools[0]).toMatchObject({ current: 2, max: 3 });
    // The ring comes off with 3 spent: nothing left, never negative.
    expect(buildTurnView(homebrew, read, actionPoolMaxima(homebrew, [])).pools[0]).toMatchObject({ current: 0, max: 2 });
  });
  it('carries the source-attributed breakdown', () => {
    const maxima = actionPoolMaxima(homebrew, [source('Ring of Haste', [mod('action_pool.attack.max', 'bonus', '1')])]);
    expect(buildTurnView(homebrew, noRow, maxima).pools[0].breakdown).toEqual([{ label: 'Base', value: 2 }, { label: 'Ring of Haste', value: 1 }]);
  });
  it('falls back to the base when maxima has no entry for a pool', () => {
    expect(buildTurnView(dnd5e, readTurnRow(null, 'dnd5e'), {}).pools.map((p) => p.max)).toEqual([1, 1, 1]);
  });
  it('lists waiting follow-ups, with the live per-action count winning over the stored one', () => {
    const read = { ...noRow, followups: { melee: { remaining: 2, sources: ['Extra Attack'], perAction: 2 } } };
    expect(buildTurnView(homebrew, read, {}, { melee: { count: 3 } }).followups).toEqual([{ cls: 'melee', label: 'Extra Attack', remaining: 2, perAction: 3 }]);
    expect(buildTurnView(homebrew, read, {}).followups[0].perAction).toBe(2);
  });
  it('hides follow-ups that are used up, and exposes the log without the source field', () => {
    const read = {
      ...noRow,
      followups: { melee: { remaining: 0, sources: [], perAction: 1 } },
      log: [{ pool: 'attack', label: 'Longsword', amount: 1, via: 'pool', source: 'Longsword', at: 't' }]
    };
    const view = buildTurnView(homebrew, read, {});
    expect(view.followups).toEqual([]);
    expect(view.log).toEqual([{ pool: 'attack', label: 'Longsword', amount: 1, via: 'pool', at: 't' }]);
  });
  it('a stale row under another profile shows full pools', () => {
    const stale = readTurnRow({ profile_key: 'attack_utility', turn_seq: 2, spent_json: { attack: 2 }, followups_json: {}, log_json: [] }, 'dnd5e');
    expect(buildTurnView(dnd5e, stale, actionPoolMaxima(dnd5e, [])).pools.map((p) => p.current)).toEqual([1, 1, 1]);
  });
});
