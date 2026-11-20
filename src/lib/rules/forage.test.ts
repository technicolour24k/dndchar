import { describe, expect, it } from 'vitest';
import { CHANCE_OPTIONS, forageAvailability, forageItemCount, isPickable, tablesForCampaign, normaliseTag, parseEntryInput, parseTableInput, pickableEntries, resolveTable, rollFind, rollFindRun, validateFindLines } from './forage';
import type { FindTableEntry, ForageCatalogue, ForageCatalogueTable } from '$lib/types/forage';

function table(overrides: Partial<ForageCatalogueTable> = {}): ForageCatalogueTable {
  return {
    id: 't1', campaignId: 'c1', name: 'Meadow - plants', areaType: 'meadow', category: 'plant',
    isArchived: false, ownerUserId: null, pickableCount: 0, entries: [], ...overrides
  };
}

describe('tablesForCampaign', () => {
  it("keeps only that campaign's active tables", () => {
    const tables = [table({ id: 'a' }), table({ id: 'b', campaignId: 'c2' }), table({ id: 'c', isArchived: true })];
    expect(tablesForCampaign(tables, 'c1').map((t) => t.id)).toEqual(['a']);
    expect(tablesForCampaign(tables, null)).toEqual([]);
  });
});

describe('forageAvailability', () => {
  const tables = [table({ pickableCount: 2 }), table({ id: 'x', campaignId: 'c2', pickableCount: 5 })];
  const base = { characterCampaignId: 'c1', roomCampaignId: 'c1', inLiveRoom: true, tables };

  it("is available in its own campaign's room, or with no room at all", () => {
    expect(forageAvailability(base)).toEqual({ available: true });
    expect(forageAvailability({ ...base, inLiveRoom: false, roomCampaignId: null })).toEqual({ available: true });
  });
  it('needs a campaign', () => {
    expect(forageAvailability({ ...base, characterCampaignId: null })).toEqual({ available: false, reason: 'no_campaign' });
  });
  it("is wrong_room in a Quick room or another campaign's room", () => {
    expect(forageAvailability({ ...base, roomCampaignId: null })).toEqual({ available: false, reason: 'wrong_room' });
    expect(forageAvailability({ ...base, roomCampaignId: 'c2' })).toEqual({ available: false, reason: 'wrong_room' });
  });
  it("is no_tables when the campaign has none, none active, or none pickable (another campaign's tables don't count)", () => {
    expect(forageAvailability({ ...base, tables: [] })).toEqual({ available: false, reason: 'no_tables' });
    expect(forageAvailability({ ...base, tables: [table({ isArchived: true, pickableCount: 3 })] })).toEqual({ available: false, reason: 'no_tables' });
    expect(forageAvailability({ ...base, tables: [table({ pickableCount: 0 })] })).toEqual({ available: false, reason: 'no_tables' });
    expect(forageAvailability({ ...base, tables: [tables[1]] })).toEqual({ available: false, reason: 'no_tables' });
  });
  it('checks the campaign first, then the room, then the tables', () => {
    expect(forageAvailability({ ...base, characterCampaignId: null, roomCampaignId: 'c2', tables: [] }).available).toBe(false);
    expect(forageAvailability({ ...base, roomCampaignId: 'c2', tables: [] })).toEqual({ available: false, reason: 'wrong_room' });
  });
});

describe('normaliseTag', () => {
  it('trims, lower-cases and collapses whitespace', () => {
    expect(normaliseTag('  Meadow ')).toBe('meadow');
    expect(normaliseTag('Wave   Echo Cave')).toBe('wave echo cave');
    expect(normaliseTag(null)).toBe('');
  });
});

describe('parseTableInput', () => {
  const ok = { name: 'Meadow - plants', areaType: 'Meadow', category: ' Plant', suggestedCheck: 'Nature DC 12' };

  it('normalises area type and category', () => {
    expect(parseTableInput(ok)).toMatchObject({ areaType: 'meadow', category: 'plant' });
  });
  it('rejects bad names, tags and suggested checks', () => {
    expect(() => parseTableInput({ ...ok, name: '  ' })).toThrow(/name/i);
    expect(() => parseTableInput({ ...ok, areaType: '' })).toThrow(/area/i);
    expect(() => parseTableInput({ ...ok, suggestedCheck: 'x'.repeat(81) })).toThrow(/suggested/i);
  });
});

describe('parseEntryInput', () => {
  it('rejects qty die 0, -1 and 1.5 with the agreed message', () => {
    for (const bad of [0, -1, 1.5, '1.5']) {
      expect(() => parseEntryInput({ chance: 30, qtyDie: bad })).toThrow('Quantity die must be 1 or more (1 means always one).');
    }
  });
  it('rejects qty die 101', () => {
    expect(() => parseEntryInput({ chance: 30, qtyDie: 101 })).toThrow(/100 or fewer/);
  });
  it('accepts qty die 1 and 100', () => {
    expect(parseEntryInput({ chance: 30, qtyDie: 1 }).qtyDie).toBe(1);
    expect(parseEntryInput({ chance: 30, qtyDie: '100' }).qtyDie).toBe(100);
  });
  it('accepts exactly the dropdown chances, including 0 (Off), as numbers or strings', () => {
    expect(CHANCE_OPTIONS.map((option) => option.percent)).toEqual([100, 50, 30, 20, 10, 5, 1, 0]);
    for (const { percent } of CHANCE_OPTIONS) {
      expect(parseEntryInput({ chance: percent, qtyDie: 1 }).chance).toBe(percent);
      expect(parseEntryInput({ chance: String(percent), qtyDie: 1 }).chance).toBe(percent);
    }
  });
  it('rejects any other chance', () => {
    for (const bad of [-1, 2, 25, 101, 1.5, '', 'abc', undefined]) {
      expect(() => parseEntryInput({ chance: bad, qtyDie: 1 })).toThrow('Pick a chance from the list.');
    }
  });
});

describe('pickable entries', () => {
  it('excludes Off (chance 0) and archived items', () => {
    expect(isPickable({ chance: 0, itemArchived: false })).toBe(false);
    expect(isPickable({ chance: 30, itemArchived: true })).toBe(false);
    expect(isPickable({ chance: 1, itemArchived: false })).toBe(true);
    const entries = [
      { chance: 10, itemArchived: false }, { chance: 0, itemArchived: false }, { chance: 20, itemArchived: true }
    ];
    expect(pickableEntries(entries)).toHaveLength(1);
  });
});

describe('resolveTable', () => {
  const catalogue: ForageCatalogue = {
    tables: [table(), table({ id: 't2', areaType: 'cave', category: 'ore', isArchived: true })]
  };

  it('finds the active table, ignoring case and spacing', () => {
    expect(resolveTable(catalogue, ' Meadow', 'PLANT')?.id).toBe('t1');
  });
  it('returns null on a miss', () => {
    expect(resolveTable(catalogue, 'swamp', 'gem')).toBeNull();
  });
  it('never returns an archived table', () => {
    expect(resolveTable(catalogue, 'cave', 'ore')).toBeNull();
  });
});

// --- The roll ---

function scripted(values: number[]) {
  const calls: number[] = [];
  const rollDie = (sides: number) => {
    calls.push(sides);
    return values[calls.length - 1] ?? 1;
  };
  return { rollDie, calls };
}

function entry(itemId: string, chance: number, qtyDie = 1, itemArchived = false): FindTableEntry {
  return { itemId, itemName: `Item ${itemId}`, itemCategory: 'consumable', chance, qtyDie, itemArchived, sortOrder: 0 };
}

// Each pickable entry is rolled on its own: a d100 first, then (only if found) its quantity die.
describe('rollFindRun (independent chances)', () => {
  it('Guaranteed (100) is found even on the highest d100', () => {
    expect(rollFindRun([entry('a', 100)], scripted([100, 1]).rollDie)).toEqual([{ itemId: 'a', qty: 1 }]);
  });

  it('is found when d100 equals the chance, and not when it is one above', () => {
    for (const { percent } of CHANCE_OPTIONS.filter((option) => option.percent > 0 && option.percent < 100)) {
      expect(rollFindRun([entry('a', percent)], scripted([percent, 1]).rollDie)).toHaveLength(1);
      expect(rollFindRun([entry('a', percent)], scripted([percent + 1, 1]).rollDie)).toEqual([]);
    }
  });

  it('never finds an Off entry, and never rolls for it', () => {
    const { rollDie, calls } = scripted([1, 1, 1]);
    expect(rollFindRun([entry('a', 0)], rollDie)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('never finds an archived entry, even a Guaranteed one, and never rolls for it', () => {
    const { rollDie, calls } = scripted([1, 1, 1]);
    expect(rollFindRun([entry('a', 100, 1, true)], rollDie)).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('rolls each entry independently: several can be found, or none', () => {
    const entries = [entry('a', 50), entry('b', 20), entry('c', 5)];
    // a: d100 50 -> found. b: d100 21 -> missed. c: d100 5 -> found.
    expect(rollFindRun(entries, scripted([50, 1, 21, 5, 1]).rollDie).map((l) => l.itemId)).toEqual(['a', 'c']);
    expect(rollFindRun(entries, scripted([51, 21, 6]).rollDie)).toEqual([]);
  });

  it('rolls the qty die only for found entries, in table order, and a d1 is always 1', () => {
    const entries = [entry('a', 50, 4), entry('b', 10, 6), entry('c', 100, 1)];
    // a: d100 40 found, qty d4 = 3. b: d100 11 missed (no qty roll). c: d100 1 found, qty d1 = 1.
    const { rollDie, calls } = scripted([40, 3, 11, 1, 1]);
    expect(rollFindRun(entries, rollDie)).toEqual([{ itemId: 'a', qty: 3 }, { itemId: 'c', qty: 1 }]);
    expect(calls).toEqual([100, 4, 100, 100, 1]);
  });
});

describe('rollFind', () => {
  it('is one run normally', () => {
    const { lines, runs } = rollFind([entry('a', 100, 6)], false, scripted([1, 4]).rollDie);
    expect(runs).toBe(1);
    expect(lines).toEqual([{ itemId: 'a', qty: 4 }]);
  });

  it('runs twice on a nat 20 and merges quantities by item', () => {
    const entries = [entry('a', 100, 6), entry('b', 10)];
    // run 1: a found qty 4, b missed (d100 50). run 2: a found qty 5, b found (d100 10).
    const { lines, runs } = rollFind(entries, true, scripted([1, 4, 50, 1, 5, 10, 1]).rollDie);
    expect(runs).toBe(2);
    expect(lines).toEqual([{ itemId: 'a', qty: 9 }, { itemId: 'b', qty: 1 }]);
  });

  it('can find nothing, and gives no lines (without rolling) when nothing is pickable', () => {
    expect(rollFind([entry('a', 5)], false, scripted([100]).rollDie).lines).toEqual([]);
    const { rollDie, calls } = scripted([]);
    expect(rollFind([entry('a', 0), entry('b', 100, 1, true)], true, rollDie).lines).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('validateFindLines', () => {
  const entries = [entry('a', 30), entry('z', 0), entry('x', 20, 1, true)];

  it('accepts valid lines, including an Off entry', () => {
    const result = validateFindLines([{ itemId: 'a', qty: 2 }, { itemId: 'z', qty: 999 }], entries);
    expect(result).toEqual({ ok: true, lines: [{ itemId: 'a', qty: 2 }, { itemId: 'z', qty: 999 }] });
  });

  it.each([
    ['another table\'s item', [{ itemId: 'nope', qty: 1 }]],
    ['an archived item', [{ itemId: 'x', qty: 1 }]],
    ['qty 0', [{ itemId: 'a', qty: 0 }]],
    ['qty 1000', [{ itemId: 'a', qty: 1000 }]],
    ['qty 1.5', [{ itemId: 'a', qty: 1.5 }]],
    ['a string qty', [{ itemId: 'a', qty: '2' }]],
    ['a duplicate', [{ itemId: 'a', qty: 1 }, { itemId: 'a', qty: 1 }]],
    ['an empty list (by default)', []],
    ['not an array', 'lines'],
    ['more than 50 lines', Array.from({ length: 51 }, () => ({ itemId: 'a', qty: 1 }))]
  ])('rejects %s', (_label, lines) => {
    expect(validateFindLines(lines, entries).ok).toBe(false);
  });
});

describe('validateFindLines with allowEmpty', () => {
  const entries = [entry('a', 30)];
  it('accepts an empty list, but still rejects a non-array', () => {
    expect(validateFindLines([], entries, 999, true)).toEqual({ ok: true, lines: [] });
    expect(validateFindLines('lines', entries, 999, true).ok).toBe(false);
  });
});

describe('forageItemCount', () => {
  it('sums quantities, not distinct items', () => {
    expect(forageItemCount([{ itemId: 'a', qty: 3 }, { itemId: 'b', qty: 2 }])).toBe(5);
  });
});
