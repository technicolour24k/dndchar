import { describe, expect, it } from 'vitest';
import { forageItemCount, isPickable, normaliseTag, parseEntryInput, parseTableInput, pickableEntries, resolveTable, rollFind, validateFindLines, weightedPickDistinct } from './forage';
import type { FindTableEntry, ForageCatalogue, ForageCatalogueTable } from '$lib/types/forage';

function table(overrides: Partial<ForageCatalogueTable> = {}): ForageCatalogueTable {
  return {
    id: 't1', name: 'Meadow - plants', areaType: 'meadow', category: 'plant', typeDie: 6,
    isArchived: false, ownerUserId: null, pickableCount: 0, entries: [], ...overrides
  };
}

describe('normaliseTag', () => {
  it('trims, lower-cases and collapses whitespace', () => {
    expect(normaliseTag('  Meadow ')).toBe('meadow');
    expect(normaliseTag('Wave   Echo Cave')).toBe('wave echo cave');
    expect(normaliseTag(null)).toBe('');
  });
});

describe('parseTableInput', () => {
  const ok = { name: 'Meadow - plants', areaType: 'Meadow', category: ' Plant', typeDie: '6', suggestedCheck: 'Nature DC 12' };

  it('normalises area type and category', () => {
    expect(parseTableInput(ok)).toMatchObject({ areaType: 'meadow', category: 'plant', typeDie: 6 });
  });
  it('rejects bad names, tags and type dice', () => {
    expect(() => parseTableInput({ ...ok, name: '  ' })).toThrow(/name/i);
    expect(() => parseTableInput({ ...ok, areaType: '' })).toThrow(/area/i);
    expect(() => parseTableInput({ ...ok, typeDie: 0 })).toThrow(/type die/i);
    expect(() => parseTableInput({ ...ok, typeDie: 101 })).toThrow(/type die/i);
    expect(() => parseTableInput({ ...ok, suggestedCheck: 'x'.repeat(81) })).toThrow(/suggested/i);
  });
});

describe('parseEntryInput', () => {
  it('rejects qty die 0, -1 and 1.5 with the agreed message', () => {
    for (const bad of [0, -1, 1.5, '1.5']) {
      expect(() => parseEntryInput({ weight: 1, qtyDie: bad })).toThrow('Quantity die must be 1 or more (1 means always one).');
    }
  });
  it('rejects qty die 101', () => {
    expect(() => parseEntryInput({ weight: 1, qtyDie: 101 })).toThrow(/100 or fewer/);
  });
  it('accepts qty die 1 and 100', () => {
    expect(parseEntryInput({ weight: 1, qtyDie: 1 }).qtyDie).toBe(1);
    expect(parseEntryInput({ weight: 1, qtyDie: '100' }).qtyDie).toBe(100);
  });
  it('accepts weight 0 but rejects negatives and huge values', () => {
    expect(parseEntryInput({ weight: 0, qtyDie: 1 }).weight).toBe(0);
    expect(() => parseEntryInput({ weight: -1, qtyDie: 1 })).toThrow(/weight/i);
    expect(() => parseEntryInput({ weight: 1001, qtyDie: 1 })).toThrow(/weight/i);
  });
});

describe('pickable entries', () => {
  it('excludes weight 0 and archived items', () => {
    expect(isPickable({ weight: 0, itemArchived: false })).toBe(false);
    expect(isPickable({ weight: 3, itemArchived: true })).toBe(false);
    expect(isPickable({ weight: 3, itemArchived: false })).toBe(true);
    const entries = [
      { weight: 1, itemArchived: false }, { weight: 0, itemArchived: false }, { weight: 2, itemArchived: true }
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

function entry(itemId: string, weight: number, qtyDie = 1, itemArchived = false): FindTableEntry {
  return { itemId, itemName: `Item ${itemId}`, itemCategory: 'consumable', weight, qtyDie, itemArchived, sortOrder: 0 };
}

describe('weightedPickDistinct', () => {
  it('never picks weight 0 or archived entries', () => {
    const entries = [entry('a', 0), entry('b', 3, 1, true), entry('c', 2)];
    const picked = weightedPickDistinct(entries, 3, (sides) => sides);
    expect(picked.map((e) => e.itemId)).toEqual(['c']);
  });

  it('passes the shrinking total weight to rollDie and walks the cumulative weights', () => {
    const entries = [entry('a', 5), entry('b', 3), entry('c', 2)];
    const { rollDie, calls } = scripted([6, 1]); // 6 lands in b (5 < 6 <= 8); then 1 lands in a
    const picked = weightedPickDistinct(entries, 2, rollDie);
    expect(picked.map((e) => e.itemId)).toEqual(['b', 'a']);
    expect(calls).toEqual([10, 7]);
  });
});

describe('rollFind', () => {
  it('caps the type roll at the pickable count', () => {
    const entries = [entry('a', 1), entry('b', 1), entry('c', 1), entry('d', 0)];
    // type roll 6 -> capped to 3; picks roll 1 each; qty die 1 -> 1 each
    const { lines, runs } = rollFind(entries, 6, false, (sides) => (sides === 6 ? 6 : 1));
    expect(runs).toBe(1);
    expect(lines.map((l) => l.itemId).sort()).toEqual(['a', 'b', 'c']);
  });

  it('rolls a qty die per pick, and a d1 is always 1', () => {
    const entries = [entry('a', 1, 4), entry('b', 1, 1)];
    // type roll 2, pick rolls 1 then 1, qty a = 3, qty b = 1 (d1)
    const { lines } = rollFind(entries, 2, false, scripted([2, 1, 1, 3, 1]).rollDie);
    expect(lines).toEqual([{ itemId: 'a', qty: 3 }, { itemId: 'b', qty: 1 }]);
  });

  it('runs twice on a nat 20 and merges quantities by item', () => {
    const entries = [entry('a', 1, 6)];
    // run 1: type 1, pick 1, qty 4. run 2: type 1, pick 1, qty 5
    const { lines, runs } = rollFind(entries, 1, true, scripted([1, 1, 4, 1, 1, 5]).rollDie);
    expect(runs).toBe(2);
    expect(lines).toEqual([{ itemId: 'a', qty: 9 }]);
  });

  it('gives no lines when nothing is pickable, without rolling', () => {
    const { rollDie, calls } = scripted([]);
    expect(rollFind([entry('a', 0), entry('b', 2, 1, true)], 6, true, rollDie).lines).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('validateFindLines', () => {
  const entries = [entry('a', 3), entry('z', 0), entry('x', 2, 1, true)];

  it('accepts valid lines, including a weight-0 entry', () => {
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
    ['an empty list', []],
    ['not an array', 'lines'],
    ['more than 50 lines', Array.from({ length: 51 }, () => ({ itemId: 'a', qty: 1 }))]
  ])('rejects %s', (_label, lines) => {
    expect(validateFindLines(lines, entries).ok).toBe(false);
  });
});

describe('forageItemCount', () => {
  it('sums quantities, not distinct items', () => {
    expect(forageItemCount([{ itemId: 'a', qty: 3 }, { itemId: 'b', qty: 2 }])).toBe(5);
  });
});
