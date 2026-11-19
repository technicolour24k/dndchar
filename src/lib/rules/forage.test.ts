import { describe, expect, it } from 'vitest';
import { isPickable, normaliseTag, parseEntryInput, parseTableInput, pickableEntries, resolveTable } from './forage';
import type { ForageCatalogue, ForageCatalogueTable } from '$lib/types/forage';

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
