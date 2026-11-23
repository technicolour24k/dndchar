import { describe, expect, it } from 'vitest';
import type { ActiveCharacterEffect, EffectModifier } from '$lib/types/character';
import type { Activation, CostAvailability, CostEntry } from '$lib/types/cost';
import type { ProfileKey, TurnCategory, TurnLine, TurnTiming } from '$lib/types/actionEconomy';
import { PROFILES } from './actionEconomy';
import {
  activationSignature,
  applySpellAccessCost,
  castingTimeActionLine,
  costSummary,
  defaultCostFor,
  effectiveCost,
  isDisplayOnlyCost,
  overrideDecision,
  itemCostConflictsWithStep,
  parseCostJson,
  planCost,
  poolMaxima,
  shortfallMode,
  validateCostEntries,
  withCategory
} from './cost';

function mod(target: string, modifierType: string, valueExpression: string, conditionExpression = ''): EffectModifier {
  return { target, modifierType, label: '', valueExpression, defaultValueExpression: valueExpression, valueOverrideExpression: '', conditionExpression, priority: 0 };
}
function source(name: string, modifiers: EffectModifier[]): ActiveCharacterEffect {
  return {
    id: name, effectId: name, effectKey: name, name, sourceType: 'feat', sourceName: name, description: '',
    durationType: 'permanent', requiresConcentration: false, isCondition: false, isSelectable: false, remainingRounds: null, modifiers
  };
}
function avail(partial: Partial<CostAvailability> = {}): CostAvailability {
  return { slots: [], counters: [], itemQuantity: null, pools: {}, ...partial };
}

describe('parseCostJson', () => {
  it('passes null through as the default', () => {
    expect(parseCostJson(null)).toEqual({ entries: null, errors: [] });
    expect(parseCostJson(undefined)).toEqual({ entries: null, errors: [] });
  });
  it('accepts [] as free and well-formed lines', () => {
    expect(parseCostJson([])).toEqual({ entries: [], errors: [] });
    const parsed = parseCostJson([
      { pool: 'spell_slot', amount: 1, level: 2 },
      { pool: 'charges', amount: 2, key: 'wand' },
      { pool: 'charges', amount: 1 },
      { pool: 'item', amount: 1 },
      { pool: 'vowfire', amount: 3 },
      { pool: 'bonus_action', amount: 1 }
    ]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(6);
    expect(parsed.entries?.[2]).toEqual({ pool: 'charges', amount: 1 });
  });
  it('lets unknown pool strings through', () => {
    expect(parseCostJson([{ pool: 'nonsense_pool', amount: 1 }]).errors).toEqual([]);
  });
  it('rejects non-arrays', () => {
    for (const bad of [{}, 'x', 3, true]) expect(parseCostJson(bad).errors).toHaveLength(1);
  });
  it('rejects bad lines and bad amounts', () => {
    for (const bad of [null, 'x', [], { amount: 1 }, { pool: '', amount: 1 }, { pool: 5, amount: 1 }]) {
      expect(parseCostJson([bad]).errors.length).toBeGreaterThan(0);
    }
    for (const amount of [0, -1, 100, 1.5, '1', null, undefined, NaN]) {
      expect(parseCostJson([{ pool: 'vowfire', amount }]).errors.length).toBeGreaterThan(0);
    }
    expect(parseCostJson([{ pool: 'vowfire', amount: 99 }]).errors).toEqual([]);
  });
  it('requires a spell_slot level of 1 to 9', () => {
    for (const level of [undefined, 0, 10, 1.5, '2']) {
      expect(parseCostJson([{ pool: 'spell_slot', amount: 1, level }]).errors.length).toBeGreaterThan(0);
    }
    expect(parseCostJson([{ pool: 'spell_slot', amount: 1, level: 9 }]).errors).toEqual([]);
  });
  it('rejects a non-text charges key and reports every bad line', () => {
    expect(parseCostJson([{ pool: 'charges', amount: 1, key: 4 }]).errors).toHaveLength(1);
    expect(parseCostJson([{ pool: 'x', amount: 0 }, { pool: 'y', amount: 100 }]).errors).toHaveLength(2);
  });
});

describe('validateCostEntries', () => {
  const ctx = { contentType: 'item', poolKeys: ['vowfire'], counterKeys: ['charge'] };
  it('accepts known pools, a single unkeyed counter, slots and display lines', () => {
    expect(validateCostEntries([{ pool: 'vowfire', amount: 1 }, { pool: 'charges', amount: 1 }, { pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'action', amount: 1 }, { pool: 'item', amount: 1 }], ctx)).toEqual([]);
  });
  it('refuses unknown pools', () => {
    expect(validateCostEntries([{ pool: 'vowfyre', amount: 1 }], ctx)).toHaveLength(1);
  });
  it('checks counters: unknown key, none, and ambiguous', () => {
    expect(validateCostEntries([{ pool: 'charges', amount: 1, key: 'nope' }], ctx)).toHaveLength(1);
    expect(validateCostEntries([{ pool: 'charges', amount: 1 }], { ...ctx, counterKeys: [] })).toHaveLength(1);
    expect(validateCostEntries([{ pool: 'charges', amount: 1 }], { ...ctx, counterKeys: ['a', 'b'] })).toHaveLength(1);
    expect(validateCostEntries([{ pool: 'charges', amount: 1, key: 'b' }], { ...ctx, counterKeys: ['a', 'b'] })).toEqual([]);
  });
  it('item quantity is for items only', () => {
    expect(validateCostEntries([{ pool: 'item', amount: 1 }], { ...ctx, contentType: 'feat' })).toHaveLength(1);
  });
});

describe('itemCostConflictsWithStep', () => {
  it('flags an explicit item line alongside a spend_item step only', () => {
    expect(itemCostConflictsWithStep([{ pool: 'item', amount: 1 }], true)).toBe(true);
    expect(itemCostConflictsWithStep([{ pool: 'item', amount: 1 }], false)).toBe(false);
    expect(itemCostConflictsWithStep([{ pool: 'vowfire', amount: 1 }], true)).toBe(false);
    expect(itemCostConflictsWithStep(null, true)).toBe(false);
  });
});

describe('castingTimeActionLine', () => {
  it('maps the three standard times', () => {
    expect(castingTimeActionLine('1 action')).toEqual({ pool: 'turn', amount: 1, timing: 'action', category: 'spell' });
    expect(castingTimeActionLine(' 1 Bonus  Action ')).toEqual({ pool: 'turn', amount: 1, timing: 'bonus_action', category: 'spell' });
    expect(castingTimeActionLine('1 reaction')).toEqual({ pool: 'turn', amount: 1, timing: 'reaction', category: 'spell' });
  });
  it('matches on a prefix, so a reaction with its trigger still counts', () => {
    expect(castingTimeActionLine('1 reaction, which you take when you are hit by an attack')).toEqual({ pool: 'turn', amount: 1, timing: 'reaction', category: 'spell' });
    expect(castingTimeActionLine('1 bonus action, or 1 action')).toMatchObject({ timing: 'bonus_action' });
  });
  it('gives none for anything else', () => {
    for (const text of ['1 minute', '10 minutes', 'Special', '', null, undefined, '2 actions', '1 actions', 'Ritual, 1 action', '1 hour']) {
      expect(castingTimeActionLine(text)).toBeNull();
    }
  });
});

describe('defaultCostFor and effectiveCost', () => {
  it('spell level 1+ costs a slot of its level plus the action line', () => {
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 3, castingTime: '1 action' })).toEqual([
      { pool: 'spell_slot', amount: 1, level: 3 }, { pool: 'turn', amount: 1, timing: 'action', category: 'spell' }
    ]);
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 1, castingTime: '1 minute' })).toEqual([{ pool: 'spell_slot', amount: 1, level: 1 }]);
  });
  it('cantrips only get the action line', () => {
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 0, castingTime: '1 bonus action' })).toEqual([{ pool: 'turn', amount: 1, timing: 'bonus_action', category: 'spell' }]);
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 0, castingTime: 'Special' })).toEqual([]);
  });
  const useAction: CostEntry = { pool: 'turn', amount: 1, timing: 'action', category: 'general' };
  it('item use costs one of itself; the general action line only comes with includeUseAction', () => {
    expect(defaultCostFor({ contentType: 'item', isItemUse: true })).toEqual([{ pool: 'item', amount: 1 }]);
    expect(defaultCostFor({ contentType: 'item', isItemUse: true, hasSpendItemStep: true })).toEqual([]);
    expect(defaultCostFor({ contentType: 'item', isItemUse: true, includeUseAction: true })).toEqual([{ pool: 'item', amount: 1 }, useAction]);
    expect(defaultCostFor({ contentType: 'item', isItemUse: true, hasSpendItemStep: true, includeUseAction: true })).toEqual([useAction]);
    expect(defaultCostFor({ contentType: 'item', isItemUse: false })).toEqual([]);
  });
  it('feats, class features and anything else have no default turn line', () => {
    for (const contentType of ['feat', 'class_feature', 'condition', 'weird']) {
      expect(defaultCostFor({ contentType, spellLevel: 5, isItemUse: true })).toEqual([]);
    }
  });
  it('a weapon attack is an attack-category action, with a timing choice', () => {
    expect(defaultCostFor({ contentType: 'item', activationKind: 'weapon_attack' })).toEqual([{ pool: 'turn', amount: 1, timing: 'action', category: 'attack' }]);
    expect(defaultCostFor({ contentType: 'item', activationKind: 'weapon_attack', weaponTiming: 'bonus_action' })[0]).toMatchObject({ timing: 'bonus_action', category: 'attack' });
    expect(defaultCostFor({ contentType: 'item', activationKind: 'weapon_attack', weaponTiming: 'reaction' })[0]).toMatchObject({ timing: 'reaction' });
  });
  it('a dash is a general action of the given count', () => {
    expect(defaultCostFor({ contentType: 'item', activationKind: 'dash', dashCount: 2 })).toEqual([{ pool: 'turn', amount: 2, timing: 'action', category: 'general' }]);
    expect(defaultCostFor({ contentType: 'item', activationKind: 'dash' })[0]).toMatchObject({ amount: 1 });
  });
  it('an explicit list wins for resources, including [] for none', () => {
    const defaults: CostEntry[] = [{ pool: 'item', amount: 1 }];
    expect(effectiveCost(null, defaults)).toBe(defaults);
    expect(effectiveCost(undefined, defaults)).toBe(defaults);
    expect(effectiveCost([], defaults)).toEqual([]);
    expect(effectiveCost([{ pool: 'vowfire', amount: 1 }], defaults)).toEqual([{ pool: 'vowfire', amount: 1 }]);
  });
  it('an explicit list without a turn line inherits the default turn line (misty step: slot + vowfire + its action)', () => {
    const bonus: CostEntry = { pool: 'turn', amount: 1, timing: 'bonus_action', category: 'spell' };
    const defaults: CostEntry[] = [{ pool: 'spell_slot', amount: 1, level: 2 }, bonus];
    expect(effectiveCost([{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }], defaults)).toEqual([
      { pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }, bonus
    ]);
    // [] means no resources, and the spell still uses its action.
    expect(effectiveCost([], defaults)).toEqual([bonus]);
  });
  it('an explicit turn line wins, and timing free makes it take no action', () => {
    const defaults: CostEntry[] = [{ pool: 'turn', amount: 1, timing: 'action', category: 'spell' }];
    const free: CostEntry = { pool: 'turn', amount: 1, timing: 'free' };
    expect(effectiveCost([free], defaults)).toEqual([free]);
    expect(effectiveCost([{ pool: 'vowfire', amount: 1 }, free], defaults)).toEqual([{ pool: 'vowfire', amount: 1 }, free]);
  });
  it('a legacy action line counts as an explicit turn line', () => {
    const parsed = parseCostJson([{ pool: 'reaction', amount: 1 }]).entries!;
    expect(effectiveCost(parsed, [{ pool: 'turn', amount: 1, timing: 'action', category: 'spell' }])).toEqual(parsed);
  });
  it('with no default turn line there is nothing to inherit', () => {
    expect(effectiveCost([{ pool: 'vowfire', amount: 1 }], [])).toEqual([{ pool: 'vowfire', amount: 1 }]);
  });
  it('withCategory fills only missing categories', () => {
    const out = withCategory([{ pool: 'turn', amount: 1, timing: 'action' }, { pool: 'vowfire', amount: 1 }], 'spell');
    expect(out).toEqual([{ pool: 'turn', amount: 1, timing: 'action', category: 'spell' }, { pool: 'vowfire', amount: 1 }]);
    expect(withCategory([{ pool: 'turn', amount: 1, timing: 'action', category: 'attack' }], 'spell')[0]).toMatchObject({ category: 'attack' });
    expect(withCategory([{ pool: 'bonus_action', amount: 1 }], 'general')[0]).toEqual({ pool: 'turn', amount: 1, timing: 'bonus_action', category: 'general' });
  });
});

describe('applySpellAccessCost', () => {
  const entries: CostEntry[] = [{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }, { pool: 'action', amount: 1 }];
  it('charges replaces the slot line with the item counter and keeps the rest', () => {
    expect(applySpellAccessCost(entries, { accessType: 'charges', resourceKey: 'wand', resourceCostExpression: '2' })).toEqual([
      { pool: 'charges', amount: 2, key: 'wand' }, { pool: 'vowfire', amount: 1 }, { pool: 'action', amount: 1 }
    ]);
  });
  it('limited_free behaves like charges', () => {
    expect(applySpellAccessCost(entries, { accessType: 'limited_free', resourceKey: 'free', resourceCostExpression: '1' })[0]).toEqual({ pool: 'charges', amount: 1, key: 'free' });
  });
  it('defaults the amount to 1 for blank or unreadable expressions, and omits the key when blank', () => {
    expect(applySpellAccessCost([], { accessType: 'charges', resourceCostExpression: '' })).toEqual([{ pool: 'charges', amount: 1 }]);
    expect(applySpellAccessCost([], { accessType: 'charges', resourceKey: 'k', resourceCostExpression: 'level' })).toEqual([{ pool: 'charges', amount: 1, key: 'k' }]);
  });
  it('matches the legacy maths: 0, negatives and junk charge 1, decimals truncate, capped at 99', () => {
    const amountFor = (expr: string) => (applySpellAccessCost([], { accessType: 'charges', resourceKey: 'k', resourceCostExpression: expr })[0] as { amount: number }).amount;
    expect(['0', '-3', 'abc', '', '0.5'].map(amountFor)).toEqual([1, 1, 1, 1, 1]);
    expect(['2.5', '3', '500'].map(amountFor)).toEqual([2, 3, 99]);
  });
  it('character_slots keeps the slot line', () => {
    expect(applySpellAccessCost(entries, { accessType: 'character_slots' })).toEqual(entries);
  });
  it('at_will drops the slot line only', () => {
    expect(applySpellAccessCost(entries, { accessType: 'at_will' }).map((e) => e.pool)).toEqual(['vowfire', 'action']);
  });
});

describe('poolMaxima', () => {
  const defs = [{ key: 'vowfire', baseMaxExpression: '0' }, { key: 'soulfire', baseMaxExpression: '1' }];
  it('sums two sources by count (2 + 3 = 5) with attributed lines', () => {
    const out = poolMaxima(defs, [source('Oath', [mod('resource.vowfire.max', 'bonus', '2')]), source('Ring', [mod('resource.vowfire.max', 'bonus', '3')])]);
    expect(out.vowfire.max).toBe(5);
    expect(out.vowfire.lines).toEqual([{ label: 'Base', value: 0 }, { label: 'Oath', value: 2 }, { label: 'Ring', value: 3 }]);
  });
  it('applies the base and ignores other pools targets', () => {
    const out = poolMaxima(defs, [source('Oath', [mod('resource.vowfire.max', 'bonus', '2')])]);
    expect(out.soulfire.max).toBe(1);
  });
  it('subtracts penalties and floors at 0', () => {
    const out = poolMaxima(defs, [source('Oath', [mod('resource.vowfire.max', 'bonus', '2')]), source('Curse', [mod('resource.vowfire.max', 'penalty', '1')])]);
    expect(out.vowfire.max).toBe(1);
    const floored = poolMaxima(defs, [source('Curse', [mod('resource.vowfire.max', 'penalty', '4')])]);
    expect(floored.vowfire.max).toBe(0);
  });
  it('skips a conditional bonus whose condition does not hold, and applies it when it does', () => {
    const sources = [source('Rage', [mod('resource.vowfire.max', 'bonus', '2', 'flag:raging')])];
    expect(poolMaxima(defs, sources).vowfire.max).toBe(0);
    expect(poolMaxima(defs, sources, { modifierContext: { flags: ['raging'] } }).vowfire.max).toBe(2);
  });
  it('labels breakdown lines by the source, not the shared modifier label', () => {
    const labelled = { ...mod('resource.vowfire.max', 'bonus', '2'), label: 'Vowfire (max)' };
    expect(poolMaxima(defs, [source('Oath of Embers', [labelled])]).vowfire.lines[1]).toEqual({ label: 'Oath of Embers', value: 2 });
  });
  it('reads a level-based base expression', () => {
    expect(poolMaxima([{ key: 'p', baseMaxExpression: 'level' }], [], { level: 4 }).p.max).toBe(4);
  });
});

describe('planCost', () => {
  const slots = (...rows: Array<[('standard' | 'pact'), number, number]>) => rows.map(([type, level, current]) => ({ type, level, current }));

  it('picks the lowest slot at or above the minimum, standard before pact', () => {
    const plan = planCost([{ pool: 'spell_slot', amount: 1, level: 2 }], avail({ slots: slots(['standard', 1, 4], ['pact', 2, 1], ['standard', 3, 2], ['standard', 2, 0]) }));
    expect(plan.shortfalls).toEqual([]);
    expect(plan.lines[0].payFrom).toEqual({ pool: 'spell_slot', slotType: 'pact', slotLevel: 2 });
    const tie = planCost([{ pool: 'spell_slot', amount: 1, level: 2 }], avail({ slots: slots(['pact', 2, 1], ['standard', 2, 1]) }));
    expect(tie.lines[0].payFrom).toEqual({ pool: 'spell_slot', slotType: 'standard', slotLevel: 2 });
  });
  it('falls back to a higher slot when the lowest is empty', () => {
    const plan = planCost([{ pool: 'spell_slot', amount: 1, level: 1 }], avail({ slots: slots(['standard', 1, 0], ['standard', 2, 0], ['standard', 3, 1]) }));
    expect(plan.lines[0].payFrom).toEqual({ pool: 'spell_slot', slotType: 'standard', slotLevel: 3 });
  });
  it('honours an upcast choice', () => {
    const plan = planCost([{ pool: 'spell_slot', amount: 1, level: 1 }], avail({ slots: slots(['standard', 1, 2], ['standard', 3, 1]) }), { slotLevel: 3 });
    expect(plan.lines[0].payFrom).toEqual({ pool: 'spell_slot', slotType: 'standard', slotLevel: 3 });
    expect(plan.lines[0].label).toBe('Level 3 Spell Slot');
  });
  it('honours a pact choice and reports a shortfall when the chosen slot is empty', () => {
    const slotRows = slots(['standard', 2, 3], ['pact', 2, 0]);
    const plan = planCost([{ pool: 'spell_slot', amount: 1, level: 1 }], avail({ slots: slotRows }), { slotType: 'pact', slotLevel: 2 });
    expect(plan.shortfalls).toEqual([{ label: 'Level 2 Spell Slot', needed: 1, available: 0 }]);
    expect(plan.lines[0].payFrom).toEqual({ pool: 'spell_slot', slotType: 'pact', slotLevel: 2 });
  });
  it('a requested level below the minimum is a shortfall, not a fallback', () => {
    const plan = planCost([{ pool: 'spell_slot', amount: 1, level: 3 }], avail({ slots: slots(['standard', 1, 5], ['standard', 3, 1]) }), { slotLevel: 1 });
    expect(plan.shortfalls).toEqual([{ label: 'Level 1 Spell Slot', needed: 1, available: 0 }]);
    expect(plan.lines[0].payFrom).toBeUndefined();
  });
  it('a slot type without a level narrows the slots', () => {
    const rows = slots(['standard', 1, 3], ['pact', 2, 1]);
    const pact = planCost([{ pool: 'spell_slot', amount: 1, level: 1 }], avail({ slots: rows }), { slotType: 'pact' });
    expect(pact.lines[0].payFrom).toEqual({ pool: 'spell_slot', slotType: 'pact', slotLevel: 2 });
    const none = planCost([{ pool: 'spell_slot', amount: 1, level: 1 }], avail({ slots: slots(['standard', 1, 3]) }), { slotType: 'pact' });
    expect(none.shortfalls).toHaveLength(1);
  });
  it('prototype keys and a NaN current are shortfalls, never free', () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      expect(planCost([{ pool: key, amount: 1 }], avail()).shortfalls).toEqual([{ label: key, needed: 1, available: 0 }]);
    }
    const nan = planCost([{ pool: 'vowfire', amount: 1 }], avail({ pools: { vowfire: { label: 'Vowfire', current: NaN } } }));
    expect(nan.shortfalls).toEqual([{ label: 'Vowfire', needed: 1, available: 0 }]);
  });
  it('is a shortfall when no suitable slot exists', () => {
    const plan = planCost([{ pool: 'spell_slot', amount: 1, level: 3 }], avail({ slots: slots(['standard', 1, 4], ['standard', 3, 0]) }));
    expect(plan.shortfalls).toEqual([{ label: 'Level 3 Spell Slot', needed: 1, available: 0 }]);
    expect(plan.lines[0].payFrom).toBeUndefined();
  });
  it('action lines are display-only and never short', () => {
    const plan = planCost([{ pool: 'action', amount: 1 }, { pool: 'bonus_action', amount: 2 }, { pool: 'reaction', amount: 1 }], avail());
    expect(plan.shortfalls).toEqual([]);
    expect(plan.lines.every((line) => line.displayOnly && !line.payFrom)).toBe(true);
  });
  it('plans pool lines and reports the shortfall in the pool label', () => {
    const pools = { vowfire: { label: 'Vowfire', current: 0 }, soulfire: { label: 'Soulfire', current: 3 } };
    const plan = planCost([{ pool: 'soulfire', amount: 2 }, { pool: 'vowfire', amount: 1 }], avail({ pools }));
    expect(plan.lines[0].payFrom).toEqual({ pool: 'pool', key: 'soulfire' });
    expect(plan.shortfalls).toEqual([{ label: 'Vowfire', needed: 1, available: 0 }]);
  });
  it('an unknown or archived pool is a shortfall labelled with the raw key', () => {
    const plan = planCost([{ pool: 'vowfyre', amount: 1 }], avail());
    expect(plan.shortfalls).toEqual([{ label: 'vowfyre', needed: 1, available: 0 }]);
  });
  it('charges: single counter without key, keyed counter, ambiguous and unknown', () => {
    const one = avail({ counters: [{ key: 'uses', label: 'Uses', current: 2 }] });
    expect(planCost([{ pool: 'charges', amount: 1 }], one).lines[0].payFrom).toEqual({ pool: 'charges', key: 'uses' });
    const two = avail({ counters: [{ key: 'a', label: 'A', current: 1 }, { key: 'b', label: 'B', current: 0 }] });
    expect(planCost([{ pool: 'charges', amount: 1, key: 'b' }], two).shortfalls).toEqual([{ label: 'B', needed: 1, available: 0 }]);
    expect(planCost([{ pool: 'charges', amount: 1 }], two).shortfalls[0].label).toBe('Unknown counter');
    expect(planCost([{ pool: 'charges', amount: 1, key: 'zzz' }], two).shortfalls[0].label).toBe('Unknown counter (zzz)');
    expect(planCost([{ pool: 'charges', amount: 1 }], avail()).shortfalls).toHaveLength(1);
  });
  it('item lines check the quantity, and are short with no item', () => {
    expect(planCost([{ pool: 'item', amount: 1 }], avail({ itemQuantity: 2 })).shortfalls).toEqual([]);
    expect(planCost([{ pool: 'item', amount: 3 }], avail({ itemQuantity: 2 })).shortfalls).toEqual([{ label: 'Item quantity', needed: 3, available: 2 }]);
    expect(planCost([{ pool: 'item', amount: 1 }], avail()).shortfalls).toHaveLength(1);
  });
  it('checks two lines on the same source against the running total', () => {
    const plan = planCost([{ pool: 'vowfire', amount: 1 }, { pool: 'vowfire', amount: 1 }], avail({ pools: { vowfire: { label: 'Vowfire', current: 1 } } }));
    expect(plan.shortfalls).toEqual([{ label: 'Vowfire', needed: 1, available: 0 }]);
  });
  it('a full mixed cost with everything affordable has no shortfalls', () => {
    const plan = planCost(
      [{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }, { pool: 'action', amount: 1 }],
      avail({ slots: slots(['standard', 2, 1]), pools: { vowfire: { label: 'Vowfire', current: 1 } } })
    );
    expect(plan.shortfalls).toEqual([]);
    expect(plan.lines).toHaveLength(3);
  });
  it('does not mutate the availability', () => {
    const a = avail({ slots: slots(['standard', 1, 1]) });
    planCost([{ pool: 'spell_slot', amount: 1, level: 1 }], a);
    expect(a.slots[0].current).toBe(1);
  });
});

describe('costSummary', () => {
  it('joins lines readably', () => {
    expect(costSummary([{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }, { pool: 'action', amount: 1 }], { vowfire: 'Vowfire' })).toBe('L2 slot + 1 Vowfire + 1 action');
  });
  it('handles plurals, other pools and free', () => {
    expect(costSummary([{ pool: 'charges', amount: 2 }, { pool: 'item', amount: 1 }, { pool: 'bonus_action', amount: 1 }, { pool: 'reaction', amount: 1 }, { pool: 'mystery', amount: 2 }])).toBe('2 charges + 1 item + 1 bonus action + 1 reaction + 2 mystery');
    expect(costSummary([{ pool: 'spell_slot', amount: 2, level: 3 }])).toBe('2 x L3 slots');
    expect(costSummary([])).toBe('Free');
  });
});

describe('overrideDecision', () => {
  const base = { hasValidApproval: false, actorIsDm: false, dmPresent: false };
  it('a valid approval always gives dm_approved', () => {
    for (const actorIsDm of [true, false]) for (const dmPresent of [true, false]) for (const requested of [undefined, 'dm', 'self'] as const) {
      expect(overrideDecision({ hasValidApproval: true, actorIsDm, dmPresent, requested })).toBe('dm_approved');
    }
  });
  it("'dm' needs a real DM", () => {
    expect(overrideDecision({ ...base, actorIsDm: true, requested: 'dm' })).toBe('dm_self');
    expect(overrideDecision({ ...base, actorIsDm: true, dmPresent: true, requested: 'dm' })).toBe('dm_self');
    expect(overrideDecision({ ...base, requested: 'dm' })).toBe('forbidden');
    expect(overrideDecision({ ...base, dmPresent: true, requested: 'dm' })).toBe('forbidden');
  });
  it("a DM actor sending 'self' resolves like dm_self", () => {
    expect(overrideDecision({ ...base, actorIsDm: true, dmPresent: true, requested: 'self' })).toBe('dm_self');
    expect(overrideDecision({ ...base, actorIsDm: true, requested: 'self' })).toBe('dm_self');
  });
  it("'self' only works with no DM present", () => {
    expect(overrideDecision({ ...base, requested: 'self' })).toBe('self_override');
    expect(overrideDecision({ ...base, dmPresent: true, requested: 'self' })).toBe('ask_dm');
  });
  it('no request and no approval grants nothing', () => {
    for (const actorIsDm of [true, false]) for (const dmPresent of [true, false]) {
      expect(overrideDecision({ hasValidApproval: false, actorIsDm, dmPresent })).toBe('ask_dm');
      expect(overrideDecision({ hasValidApproval: false, actorIsDm, dmPresent, requested: null })).toBe('ask_dm');
    }
  });
});

describe('shortfallMode', () => {
  it('picks the prompt', () => {
    expect(shortfallMode({ actorIsDm: true, dmPresent: true })).toBe('dm_self');
    expect(shortfallMode({ actorIsDm: true, dmPresent: false })).toBe('dm_self');
    expect(shortfallMode({ actorIsDm: false, dmPresent: true })).toBe('ask_dm');
    expect(shortfallMode({ actorIsDm: false, dmPresent: false })).toBe('no_dm');
  });
});

describe('activationSignature', () => {
  it('is stable and distinguishes kind, ids and slot choice', () => {
    const a = activationSignature({ kind: 'spell', instanceId: 'i1', slotType: 'standard', slotLevel: 3 });
    expect(a).toBe(activationSignature({ kind: 'spell', instanceId: 'i1', slotType: 'standard', slotLevel: 3 }));
    expect(a).not.toBe(activationSignature({ kind: 'spell', instanceId: 'i1', slotType: 'standard', slotLevel: 2 }));
    expect(a).not.toBe(activationSignature({ kind: 'spell', instanceId: 'i1', slotType: 'pact', slotLevel: 3 }));
    expect(a).not.toBe(activationSignature({ kind: 'spell', instanceId: 'i2', slotType: 'standard', slotLevel: 3 }));
    expect(activationSignature({ kind: 'spell', instanceId: 'i1' })).not.toBe(a);
  });
  it('separates the kinds even with the same id', () => {
    const sigs = [
      activationSignature({ kind: 'spell', instanceId: 'x' }),
      activationSignature({ kind: 'content', instanceId: 'x' }),
      activationSignature({ kind: 'item', inventoryId: 'x' }),
      activationSignature({ kind: 'spell_access', spellAccessId: 'x', inventoryItemId: 'x' })
    ];
    expect(new Set(sigs).size).toBe(4);
  });
  it('covers both ids of a spell_access activation', () => {
    expect(activationSignature({ kind: 'spell_access', spellAccessId: 'a', inventoryItemId: 'b' }))
      .not.toBe(activationSignature({ kind: 'spell_access', spellAccessId: 'a', inventoryItemId: 'c' }));
  });
  it('weapon_attack: stable, an id names the weapon, a label names an id-less attack, timing counts', () => {
    const sig = (a: Activation) => activationSignature(a);
    expect(sig({ kind: 'weapon_attack', inventoryId: 'w1' })).toBe('weapon_attack|w1||action|use');
    expect(sig({ kind: 'weapon_attack', inventoryId: 'w1' })).toBe(sig({ kind: 'weapon_attack', inventoryId: 'w1', timing: 'action' }));
    expect(sig({ kind: 'weapon_attack', inventoryId: 'w1' })).not.toBe(sig({ kind: 'weapon_attack', inventoryId: 'w1', timing: 'reaction' }));
    expect(sig({ kind: 'weapon_attack', inventoryId: 'w1' })).not.toBe(sig({ kind: 'weapon_attack', inventoryId: 'w2' }));
    // The label is ignored once there is an id, and matters when there isn't.
    expect(sig({ kind: 'weapon_attack', inventoryId: 'w1', label: 'x' })).toBe(sig({ kind: 'weapon_attack', inventoryId: 'w1', label: 'y' }));
    expect(sig({ kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike' })).toBe('weapon_attack|none|Unarmed Strike|action|use');
    expect(sig({ kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike' })).not.toBe(sig({ kind: 'weapon_attack', inventoryId: null, label: 'Bite' }));
    expect(sig({ kind: 'weapon_attack', inventoryId: null })).toBe('weapon_attack|none||action|use');
  });
  it('the follow-up choice is part of the signature: weapons default to use, spells to skip', () => {
    const w = (followup?: 'use' | 'skip' | 'require') => activationSignature({ kind: 'weapon_attack', inventoryId: 'w1', ...(followup ? { followup } : {}) });
    expect(w()).toBe(w('use'));
    expect(w('skip')).not.toBe(w('use'));
    expect(w('require')).not.toBe(w('use')); // an approval for a free repeat never unlocks a paid attack
    const s = (followup?: 'use' | 'skip') => activationSignature({ kind: 'spell', instanceId: 'i1', slotType: 'standard', slotLevel: 3, ...(followup ? { followup } : {}) });
    expect(s()).toBe(s('skip'));
    expect(s('use')).not.toBe(s('skip'));
    const a = (followup?: 'use' | 'skip') => activationSignature({ kind: 'spell_access', spellAccessId: 'a', inventoryItemId: 'b', ...(followup ? { followup } : {}) });
    expect(a('use')).not.toBe(a());
  });
  it('dash: stable per count and distinct from everything else', () => {
    expect(activationSignature({ kind: 'dash', count: 1 })).toBe('dash|1');
    expect(activationSignature({ kind: 'dash', count: 1 })).not.toBe(activationSignature({ kind: 'dash', count: 2 }));
  });
});

describe('turn lines: parseCostJson', () => {
  it('accepts a full turn line and keeps only the known fields', () => {
    const parsed = parseCostJson([{ pool: 'turn', amount: 1, timing: 'bonus_action', category: 'spell', actionPool: 'utility', junk: 1 }]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toEqual([{ pool: 'turn', amount: 1, timing: 'bonus_action', category: 'spell', actionPool: 'utility' }]);
  });
  it('category and actionPool are optional', () => {
    expect(parseCostJson([{ pool: 'turn', amount: 2, timing: 'free' }]).entries).toEqual([{ pool: 'turn', amount: 2, timing: 'free' }]);
    expect(parseCostJson([{ pool: 'turn', amount: 1, timing: 'action', category: null, actionPool: null }]).entries).toEqual([{ pool: 'turn', amount: 1, timing: 'action' }]);
  });
  it('validates timing, category and actionPool', () => {
    for (const timing of [undefined, 'sometimes', 5, '']) expect(parseCostJson([{ pool: 'turn', amount: 1, timing }]).errors).toHaveLength(1);
    expect(parseCostJson([{ pool: 'turn', amount: 1, timing: 'action', category: 'melee' }]).errors).toHaveLength(1);
    expect(parseCostJson([{ pool: 'turn', amount: 1, timing: 'action', actionPool: 'mana' }]).errors).toHaveLength(1);
    expect(parseCostJson([{ pool: 'turn', amount: 0, timing: 'action' }]).errors).toHaveLength(1);
    for (const actionPool of ['action', 'bonus_action', 'reaction', 'attack', 'utility']) {
      expect(parseCostJson([{ pool: 'turn', amount: 1, timing: 'action', actionPool }]).errors).toEqual([]);
    }
  });
  it('normalises legacy action lines to turn lines with no category', () => {
    expect(parseCostJson([{ pool: 'action', amount: 1 }]).entries).toEqual([{ pool: 'turn', amount: 1, timing: 'action' }]);
    expect(parseCostJson([{ pool: 'bonus_action', amount: 1 }]).entries).toEqual([{ pool: 'turn', amount: 1, timing: 'bonus_action' }]);
    expect(parseCostJson([{ pool: 'reaction', amount: 2 }]).entries).toEqual([{ pool: 'turn', amount: 2, timing: 'reaction' }]);
  });
  it('stored costs keep the first turn line and ignore the rest, never erroring', () => {
    const stored = (value: unknown) => parseCostJson(value, { stored: true });
    expect(stored([{ pool: 'vowfire', amount: 1 }, { pool: 'action', amount: 1 }, { pool: 'reaction', amount: 1 }]))
      .toEqual({ entries: [{ pool: 'vowfire', amount: 1 }, { pool: 'turn', amount: 1, timing: 'action' }], errors: [] });
    expect(stored([{ pool: 'turn', amount: 1, timing: 'free' }, { pool: 'turn', amount: 1, timing: 'action' }]).entries).toEqual([{ pool: 'turn', amount: 1, timing: 'free' }]);
    // Still rejects a malformed line.
    expect(stored([{ pool: 'turn', amount: 1, timing: 'nope' }]).errors).toHaveLength(1);
  });
  it('authors get every line back, and validateCostEntries refuses more than one turn line', () => {
    const parsed = parseCostJson([{ pool: 'action', amount: 1 }, { pool: 'turn', amount: 1, timing: 'free' }]);
    expect(parsed.errors).toEqual([]);
    expect(parsed.entries).toHaveLength(2);
    const ctx = { contentType: 'feat', poolKeys: [], counterKeys: [] };
    expect(validateCostEntries(parsed.entries!, ctx)).toHaveLength(1);
    expect(validateCostEntries([{ pool: 'turn', amount: 2, timing: 'action' }], ctx)).toEqual([]);
  });
  it('isDisplayOnlyCost covers turn and legacy action lines only', () => {
    for (const pool of ['turn', 'action', 'bonus_action', 'reaction']) expect(isDisplayOnlyCost({ pool })).toBe(true);
    for (const pool of ['spell_slot', 'charges', 'item', 'vowfire']) expect(isDisplayOnlyCost({ pool })).toBe(false);
    // A cantrip's cost is turn-only, so the cast dialog has nothing to prompt for.
    const cantrip = defaultCostFor({ contentType: 'spell', spellLevel: 0, castingTime: '1 action' });
    expect(cantrip.some((entry) => !isDisplayOnlyCost(entry))).toBe(false);
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 1, castingTime: '1 action' }).some((entry) => !isDisplayOnlyCost(entry))).toBe(true);
  });
  it('validateCostEntries accepts turn lines', () => {
    expect(validateCostEntries([{ pool: 'turn', amount: 1, timing: 'action', category: 'general' }], { contentType: 'feat', poolKeys: [], counterKeys: [] })).toEqual([]);
  });
});

describe('turn lines: planCost', () => {
  const line = (timing: TurnTiming, category?: TurnCategory, extra: Partial<TurnLine> = {}): CostEntry => ({ pool: 'turn', amount: 1, timing, ...(category ? { category } : {}), ...extra });
  const slots3 = [{ type: 'standard' as const, level: 3, current: 1 }];
  const turn = (profile: ProfileKey, current: Record<string, number>, followups: Record<string, number> = {}): CostAvailability => {
    const defs = PROFILES[profile].pools;
    return avail({ turn: { profile, pools: Object.fromEntries(defs.map((d) => [d.key, { label: d.label, current: current[d.key] ?? 0 }])), followups } });
  };

  it('without turn state a turn line stays display-only and never short', () => {
    const plan = planCost([line('action', 'spell'), line('reaction')], avail());
    expect(plan.shortfalls).toEqual([]);
    expect(plan.lines.map((l) => [l.label, l.displayOnly, l.payFrom])).toEqual([['Action', true, undefined], ['Reaction', true, undefined]]);
  });
  it('5e: pays the pool its timing names, and reports a shortfall by pool label', () => {
    const plan = planCost([line('bonus_action', 'spell')], turn('dnd5e', { bonus_action: 1 }));
    expect(plan.lines[0]).toMatchObject({ label: 'Bonus action', payFrom: { pool: 'turn', key: 'bonus_action' }, displayOnly: false });
    expect(plan.shortfalls).toEqual([]);
    expect(planCost([line('action', 'spell')], turn('dnd5e', { action: 0 })).shortfalls).toEqual([{ label: 'Action', needed: 1, available: 0 }]);
  });
  it('homebrew: a spell draws Attack, a general line Utility, whatever the timing', () => {
    const a = turn('attack_utility', { attack: 2, utility: 2 });
    expect(planCost([line('reaction', 'spell')], a).lines[0].payFrom).toEqual({ pool: 'turn', key: 'attack' });
    expect(planCost([line('action', 'general')], a).lines[0].payFrom).toEqual({ pool: 'turn', key: 'utility' });
  });
  it('free and movement lines are display-only "Free" in both profiles', () => {
    for (const profile of ['dnd5e', 'attack_utility'] as const) {
      const plan = planCost([line('free', 'general'), line('movement', 'general')], turn(profile, {}));
      expect(plan.shortfalls).toEqual([]);
      expect(plan.lines.map((l) => [l.label, l.displayOnly])).toEqual([['Free', true], ['Free', true]]);
    }
  });
  it('a missing category reads as general', () => {
    expect(planCost([line('action')], turn('attack_utility', { attack: 2, utility: 2 })).lines[0].payFrom).toEqual({ pool: 'turn', key: 'utility' });
  });
  it('the actionPool escape hatch applies only when the profile has that pool', () => {
    const forced = line('action', 'spell', { actionPool: 'utility' });
    expect(planCost([forced], turn('attack_utility', { attack: 2, utility: 2 })).lines[0].payFrom).toEqual({ pool: 'turn', key: 'utility' });
    expect(planCost([forced], turn('dnd5e', { action: 1 })).lines[0].payFrom).toEqual({ pool: 'turn', key: 'action' });
  });
  it('checks the turn pool against the running total with the amount', () => {
    const two: CostEntry = { pool: 'turn', amount: 2, timing: 'action', category: 'attack' };
    expect(planCost([two], turn('attack_utility', { attack: 1 })).shortfalls).toEqual([{ label: 'Attack', needed: 2, available: 1 }]);
    expect(planCost([two], turn('attack_utility', { attack: 2 })).shortfalls).toEqual([]);
  });
  it('a waiting follow-up covers the turn line when asked, and only then', () => {
    const a = turn('attack_utility', { attack: 0 }, { melee: 1 });
    const attack = line('action', 'attack');
    const covered = planCost([attack], a, { followupClass: 'melee' });
    expect(covered.shortfalls).toEqual([]);
    expect(covered.lines[0]).toMatchObject({ label: 'Extra Attack', payFrom: { pool: 'followup', cls: 'melee' }, displayOnly: false });
    // Not asked: it pays the pool (and is short here).
    expect(planCost([attack], a).shortfalls).toEqual([{ label: 'Attack', needed: 1, available: 0 }]);
  });
  it('a spell echo is completely free and resolves at the base level', () => {
    const fireball: CostEntry[] = [{ pool: 'spell_slot', amount: 1, level: 3 }, { pool: 'vowfire', amount: 1 }, line('action', 'spell')];
    const a = { ...turn('attack_utility', { attack: 0 }, { spell: 1 }), slots: [{ type: 'standard' as const, level: 5, current: 0 }] };
    const plan = planCost(fireball, a, { followupClass: 'spell' });
    // No slot, no Vowfire, no action: only the follow-up itself is consumed, and no shortfall even with nothing left.
    expect(plan.shortfalls).toEqual([]);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({ payFrom: { pool: 'followup', cls: 'spell' }, displayOnly: false });
    expect(plan.castAtLevel).toBe(3);
  });
  it('a cantrip echo has no cast level; a spell with no waiting echo is planned normally', () => {
    const cantrip = planCost([line('action', 'spell')], turn('dnd5e', {}, { cantrip: 1 }), { followupClass: 'cantrip' });
    expect(cantrip.lines[0].payFrom).toEqual({ pool: 'followup', cls: 'cantrip' });
    expect(cantrip.castAtLevel).toBeUndefined();
    const normal = planCost([{ pool: 'spell_slot', amount: 1, level: 3 }, line('action', 'spell')], { ...turn('dnd5e', { action: 1 }, { spell: 0 }), slots: slots3 }, { followupClass: 'spell' });
    expect(normal.lines).toHaveLength(2);
    expect(normal.castAtLevel).toBeUndefined();
  });
  it('a weapon follow-up waives only the action: other lines are still paid', () => {
    const a = { ...turn('attack_utility', { attack: 0 }, { melee: 1 }), pools: { vowfire: { label: 'Vowfire', current: 0 } } };
    const plan = planCost([{ pool: 'vowfire', amount: 1 }, line('action', 'attack')], a, { followupClass: 'melee' });
    expect(plan.shortfalls).toEqual([{ label: 'Vowfire', needed: 1, available: 0 }]);
    expect(plan.lines[1].payFrom).toEqual({ pool: 'followup', cls: 'melee' });
    expect(plan.castAtLevel).toBeUndefined();
  });
  it('follow-ups are keyed by type: a melee follow-up does not cover a spell', () => {
    const a = turn('attack_utility', { attack: 0 }, { melee: 1, ranged: 1 });
    expect(planCost([line('action', 'spell')], a, { followupClass: 'spell' }).shortfalls).toEqual([{ label: 'Attack', needed: 1, available: 0 }]);
    expect(planCost([line('action', 'attack')], a, { followupClass: 'ranged' }).lines[0].payFrom).toEqual({ pool: 'followup', cls: 'ranged' });
    expect(planCost([line('action', 'spell')], turn('dnd5e', {}, { cantrip: 2 }), { followupClass: 'cantrip' }).lines[0].payFrom).toEqual({ pool: 'followup', cls: 'cantrip' });
  });
  it('a follow-up only covers a one-action line', () => {
    const two: CostEntry = { pool: 'turn', amount: 2, timing: 'action', category: 'attack' };
    const a = turn('attack_utility', { attack: 2 }, { melee: 3 });
    const plan = planCost([two], a, { followupClass: 'melee' });
    expect(plan.lines[0].payFrom).toEqual({ pool: 'turn', key: 'attack' });
    const spellTwo: CostEntry[] = [{ pool: 'spell_slot', amount: 1, level: 3 }, { pool: 'turn', amount: 2, timing: 'action', category: 'spell' }];
    const echo = planCost(spellTwo, { ...turn('attack_utility', { attack: 2 }, { spell: 2 }), slots: slots3 }, { followupClass: 'spell' });
    expect(echo.castAtLevel).toBeUndefined();
    expect(echo.lines).toHaveLength(2);
  });
  it('with no follow-ups left the pool pays', () => {
    const a = turn('attack_utility', { attack: 1 }, { melee: 0 });
    expect(planCost([line('action', 'attack')], a, { followupClass: 'melee' }).lines[0].payFrom).toEqual({ pool: 'turn', key: 'attack' });
  });
  it('a free line takes no follow-up even when one is waiting', () => {
    const plan = planCost([line('free', 'attack')], turn('attack_utility', {}, { melee: 1 }), { followupClass: 'melee' });
    expect(plan.lines[0]).toMatchObject({ label: 'Free', displayOnly: true });
  });
  it('legacy hand-built action lines plan like turn lines', () => {
    expect(planCost([{ pool: 'action', amount: 1 }], turn('dnd5e', { action: 1 })).lines[0].payFrom).toEqual({ pool: 'turn', key: 'action' });
  });
  it('mixes with resource lines and does not mutate the availability', () => {
    const a = { ...turn('dnd5e', { action: 1 }), pools: { vowfire: { label: 'Vowfire', current: 0 } } };
    const plan = planCost([{ pool: 'vowfire', amount: 1 }, line('action', 'spell')], a);
    expect(plan.shortfalls).toEqual([{ label: 'Vowfire', needed: 1, available: 0 }]);
    expect(a.turn!.pools.action.current).toBe(1);
  });
});

describe('turn lines: costSummary', () => {
  const fireball: CostEntry[] = [{ pool: 'spell_slot', amount: 1, level: 3 }, { pool: 'turn', amount: 1, timing: 'action', category: 'spell' }];
  it('reads in the profile words: "1 Action" in 5e, "1 Attack action" in homebrew', () => {
    expect(costSummary(fireball, {}, 'dnd5e')).toBe('L3 slot + 1 Action');
    expect(costSummary(fireball, {}, 'attack_utility')).toBe('L3 slot + 1 Attack action');
    expect(costSummary([{ pool: 'turn', amount: 2, timing: 'action', category: 'general' }], {}, 'attack_utility')).toBe('2 Utility actions');
  });
  it('unknown profile keys fall back to 5e', () => {
    expect(costSummary(fireball, {}, 'mystery')).toBe('L3 slot + 1 Action');
  });
  it('without a profile it reads as the old display-only text', () => {
    expect(costSummary(fireball)).toBe('L3 slot + 1 action');
    expect(costSummary([{ pool: 'turn', amount: 1, timing: 'reaction' }])).toBe('1 reaction');
  });
  it('free and movement lines add nothing, and an all-free cost says Free', () => {
    expect(costSummary([{ pool: 'vowfire', amount: 1 }, { pool: 'turn', amount: 1, timing: 'free' }], { vowfire: 'Vowfire' }, 'dnd5e')).toBe('1 Vowfire');
    expect(costSummary([{ pool: 'turn', amount: 1, timing: 'movement' }], {}, 'attack_utility')).toBe('Free');
    expect(costSummary([{ pool: 'turn', amount: 1, timing: 'free' }])).toBe('Free');
  });
  it('the specific-pool escape hatch shows in the profile that has it', () => {
    const forced: CostEntry[] = [{ pool: 'turn', amount: 1, timing: 'action', category: 'spell', actionPool: 'utility' }];
    expect(costSummary(forced, {}, 'attack_utility')).toBe('1 Utility action');
    expect(costSummary(forced, {}, 'dnd5e')).toBe('1 Action');
  });
});

describe('sumTargetGrants via poolMaxima stays source-labelled', () => {
  it('still ignores zero-value grants', () => {
    const out = poolMaxima([{ key: 'p', baseMaxExpression: '1' }], [source('Nothing', [mod('resource.p.max', 'bonus', '0')])]);
    expect(out.p.lines).toEqual([{ label: 'Base', value: 1 }]);
  });
});
