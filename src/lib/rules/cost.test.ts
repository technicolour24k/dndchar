import { describe, expect, it } from 'vitest';
import type { ActiveCharacterEffect, EffectModifier } from '$lib/types/character';
import type { CostAvailability, CostEntry } from '$lib/types/cost';
import {
  activationSignature,
  applySpellAccessCost,
  castingTimeActionLine,
  costSummary,
  defaultCostFor,
  effectiveCost,
  overrideDecision,
  parseCostJson,
  planCost,
  poolMaxima,
  shortfallMode
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

describe('castingTimeActionLine', () => {
  it('maps the three standard times', () => {
    expect(castingTimeActionLine('1 action')).toEqual({ pool: 'action', amount: 1 });
    expect(castingTimeActionLine(' 1 Bonus  Action ')).toEqual({ pool: 'bonus_action', amount: 1 });
    expect(castingTimeActionLine('1 reaction')).toEqual({ pool: 'reaction', amount: 1 });
  });
  it('gives none for anything else', () => {
    for (const text of ['1 minute', '10 minutes', 'Special', '', null, undefined, '1 reaction, which you take when hit']) {
      expect(castingTimeActionLine(text)).toBeNull();
    }
  });
});

describe('defaultCostFor and effectiveCost', () => {
  it('spell level 1+ costs a slot of its level plus the action line', () => {
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 3, castingTime: '1 action' })).toEqual([
      { pool: 'spell_slot', amount: 1, level: 3 }, { pool: 'action', amount: 1 }
    ]);
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 1, castingTime: '1 minute' })).toEqual([{ pool: 'spell_slot', amount: 1, level: 1 }]);
  });
  it('cantrips only get the action line', () => {
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 0, castingTime: '1 bonus action' })).toEqual([{ pool: 'bonus_action', amount: 1 }]);
    expect(defaultCostFor({ contentType: 'spell', spellLevel: 0, castingTime: 'Special' })).toEqual([]);
  });
  it('item use costs one of itself unless a spend_item step pays', () => {
    expect(defaultCostFor({ contentType: 'item', isItemUse: true })).toEqual([{ pool: 'item', amount: 1 }]);
    expect(defaultCostFor({ contentType: 'item', isItemUse: true, hasSpendItemStep: true })).toEqual([]);
    expect(defaultCostFor({ contentType: 'item', isItemUse: false })).toEqual([]);
  });
  it('feats, class features and anything else are free', () => {
    for (const contentType of ['feat', 'class_feature', 'condition', 'weird']) {
      expect(defaultCostFor({ contentType, spellLevel: 5, isItemUse: true })).toEqual([]);
    }
  });
  it('an explicit list wins, including [] for free', () => {
    const defaults: CostEntry[] = [{ pool: 'item', amount: 1 }];
    expect(effectiveCost(null, defaults)).toBe(defaults);
    expect(effectiveCost(undefined, defaults)).toBe(defaults);
    expect(effectiveCost([], defaults)).toEqual([]);
    expect(effectiveCost([{ pool: 'vowfire', amount: 1 }], defaults)).toEqual([{ pool: 'vowfire', amount: 1 }]);
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
});
