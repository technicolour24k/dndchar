import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import { query } from '$lib/server/db';
import { invalidateReferenceData } from '$lib/server/cache/referenceData';
import { withTransaction } from '$lib/server/db';
import {
  addFindTableEntry, canEditFindTable, createFindTable, loadForageCatalogue, markSelfFind, removeFindTableEntry,
  tablesForActor, toggleFindTableArchived, updateFindTable, updateFindTableEntries
} from './forage';
import type { FindTable } from '$lib/types/forage';

const T1 = '11111111-1111-4111-8111-111111111111';
const I1 = '22222222-2222-4222-8222-222222222222';
const I2 = '33333333-3333-4333-8333-333333333333';
const I3 = '44444444-4444-4444-8444-444444444444';
const queryMock = vi.mocked(query);
const user = { id: 'u1', role: 'user' as const };
const admin = { id: 'a1', role: 'admin' as const };

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

beforeEach(() => {
  queryMock.mockReset();
  invalidateReferenceData('test setup');
});

describe('canEditFindTable', () => {
  it('allows the owner and admins, not other users or orphaned tables', () => {
    expect(canEditFindTable(user, { ownerUserId: 'u1' })).toBe(true);
    expect(canEditFindTable(user, { ownerUserId: 'u2' })).toBe(false);
    expect(canEditFindTable(user, { ownerUserId: null })).toBe(false);
    expect(canEditFindTable(admin, { ownerUserId: 'u2' })).toBe(true);
    expect(canEditFindTable(admin, { ownerUserId: null })).toBe(true);
  });
});

describe('createFindTable', () => {
  const fields = { name: 'Meadow - plants', areaType: 'Meadow', category: 'plant', typeDie: '6' };

  it('stores normalised tags with the creator as owner', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ id: T1 }], rowCount: 1 } as any);
    expect(await createFindTable(user, form(fields))).toBe(T1);
    expect(queryMock.mock.calls[0][1]).toEqual(['Meadow - plants', 'meadow', 'plant', 6, '', 'u1']);
  });

  it('maps a unique violation to the friendly message', async () => {
    queryMock.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(createFindTable(user, form(fields))).rejects.toThrow("There's already an active table for meadow + plant.");
  });
});

describe('editing permissions', () => {
  it('refuses a non-owner non-admin before writing anything', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ owner_user_id: 'someone-else' }], rowCount: 1 } as any);
    await expect(updateFindTable(user, form({ tableId: T1, name: 'x', areaType: 'a', category: 'b', typeDie: '3' })))
      .rejects.toThrow(/only edit find tables you created/);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('refuses to add an archived item', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ owner_user_id: 'u1' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ is_archived: true }], rowCount: 1 } as any);
    await expect(addFindTableEntry(user, form({ tableId: T1, itemId: I1, weight: '1', qtyDie: '1' })))
      .rejects.toThrow(/archived/);
  });

  it('refuses a content row that is not an item', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ owner_user_id: 'u1' }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    await expect(addFindTableEntry(user, form({ tableId: T1, itemId: I1, weight: '1', qtyDie: '1' })))
      .rejects.toThrow(/not an item/);
  });
});

describe('more write rules', () => {
  const owned = { rows: [{ owner_user_id: 'u1' }], rowCount: 1 } as any;

  it('refuses a repeat add instead of overwriting the tuned entry', async () => {
    queryMock
      .mockResolvedValueOnce(owned)
      .mockResolvedValueOnce({ rows: [{ is_archived: false }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // ON CONFLICT DO NOTHING inserted nothing
    await expect(addFindTableEntry(user, form({ tableId: T1, itemId: I1, weight: '1', qtyDie: '1' })))
      .rejects.toThrow('That item is already on this table.');
  });

  it('validates every entry before writing any', async () => {
    queryMock.mockResolvedValueOnce(owned);
    const data = new FormData();
    data.append('tableId', T1);
    data.append('entryItem', I1); data.append('weight', '3'); data.append('qtyDie', '2');
    data.append('entryItem', I2); data.append('weight', '3'); data.append('qtyDie', '0'); // bad
    await expect(updateFindTableEntries(user, data)).rejects.toThrow(/Quantity die/);
    expect(vi.mocked(withTransaction)).not.toHaveBeenCalled();
  });

  it('gives the friendly error when restoring an archived table hits the unique index', async () => {
    queryMock
      .mockResolvedValueOnce(owned)
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [{ area_type: 'meadow', category: 'plant' }], rowCount: 1 } as any);
    await expect(toggleFindTableArchived(user, form({ tableId: T1 })))
      .rejects.toThrow("There's already an active table for meadow + plant.");
  });

  it('refuses removeFindTableEntry for a non-owner and never deletes', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ owner_user_id: 'other' }], rowCount: 1 } as any);
    await expect(removeFindTableEntry(user, form({ tableId: T1, itemId: I1 }))).rejects.toThrow(/only edit/);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('treats malformed ids as not found, not a raw Postgres error', async () => {
    await expect(removeFindTableEntry(user, form({ tableId: 'nope', itemId: I1 }))).rejects.toThrow('Find table not found.');
    queryMock.mockResolvedValueOnce(owned);
    await expect(removeFindTableEntry(user, form({ tableId: T1, itemId: 'nope' }))).rejects.toThrow('Item not found.');
  });

  it('a write invalidates the catalogue cache so the next load re-queries', async () => {
    const empty = { rows: [] } as any;
    queryMock.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty);
    await loadForageCatalogue();
    expect(queryMock).toHaveBeenCalledTimes(2);
    queryMock.mockResolvedValueOnce(owned).mockResolvedValueOnce({ rows: [], rowCount: 1 } as any).mockResolvedValueOnce({ rows: [], rowCount: 1 } as any);
    await removeFindTableEntry(user, form({ tableId: T1, itemId: I1 }));
    queryMock.mockResolvedValueOnce(empty).mockResolvedValueOnce(empty);
    await loadForageCatalogue();
    expect(queryMock).toHaveBeenCalledTimes(7);
  });
});

describe('tablesForActor (Q9)', () => {
  const base: FindTable = {
    id: T1, name: 'n', areaType: 'a', category: 'b', typeDie: 3, suggestedCheck: 'Nature DC 12', isArchived: false,
    ownerUserId: 'u1', ownerName: 'Me', entryCount: 0, pickableCount: 0
  };
  it('shows the suggested check to the owner and admins only', () => {
    expect(tablesForActor(user, [base])[0]).toMatchObject({ canEdit: true, suggestedCheck: 'Nature DC 12' });
    expect(tablesForActor(admin, [base])[0].suggestedCheck).toBe('Nature DC 12');
    expect(tablesForActor({ id: 'u2', role: 'user' }, [base])[0]).toMatchObject({ canEdit: false, suggestedCheck: '' });
  });
});

describe('loadForageCatalogue', () => {
  it('runs two queries and counts pickable entries, flagging archived items', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: T1, name: 'Meadow', area_type: 'meadow', category: 'plant', type_die: 6, suggested_check: 'Nature DC 12',
        is_archived: false, owner_user_id: null, owner_name: null, entry_count: 0, pickable_count: 0
      }] } as any)
      .mockResolvedValueOnce({ rows: [
        { find_table_id: T1, item_id: I1, item_name: 'Moonleaf', item_category: 'consumable', weight: 5, qty_die: 4, sort_order: 0, item_archived: false },
        { find_table_id: T1, item_id: I2, item_name: 'Stalk', item_category: 'consumable', weight: 4, qty_die: 2, sort_order: 1, item_archived: true },
        { find_table_id: T1, item_id: I3, item_name: 'Moss', item_category: 'consumable', weight: 0, qty_die: 3, sort_order: 2, item_archived: false }
      ] } as any);
    const catalogue = await loadForageCatalogue();
    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(catalogue.tables[0].pickableCount).toBe(1);
    expect(catalogue.tables[0].entries).toHaveLength(3);
    // player-safe: the cached catalogue never carries the DM-side suggested check
    expect(JSON.stringify(catalogue)).not.toContain('suggestedCheck');
    // cached: a second call makes no more queries
    await loadForageCatalogue();
    expect(queryMock).toHaveBeenCalledTimes(2);
  });
});

describe('markSelfFind when the table has gone (Rev 4: players have no table picker)', () => {
  const FIND = '55555555-5555-4555-8555-555555555555';
  const findRow = {
    id: FIND, character_id: 'c1', room_code: null, game_session_id: null, find_table_id: T1, nat20: false,
    check_json: { skillKey: 'nature', skillLabel: 'Nature', total: 15, natural: 12, nat20: false, nat1: false, text: '', poolSummary: '' }
  };

  // A fake transaction client answering the queries markSelfFind makes, in order.
  function fakeClient(tableRows: Array<{ type_die: number }>, entryRows: unknown[] = []) {
    const client = {
      query: vi.fn(async (sql: string, _params?: unknown[]) => {
        if (/FROM finds WHERE id/.test(sql)) return { rows: [findRow], rowCount: 1 };
        if (/FROM find_tables WHERE id/.test(sql)) return { rows: tableRows, rowCount: tableRows.length };
        if (/find_table_entries|find_table_id = \$1/.test(sql) && /SELECT/.test(sql)) return { rows: entryRows, rowCount: entryRows.length };
        return { rows: [], rowCount: 1 };
      })
    };
    vi.mocked(withTransaction).mockImplementation(async (fn: any) => fn(client));
    return client;
  }

  async function mark() {
    return markSelfFind({ findId: FIND, userId: 'u1', passed: true });
  }

  it('closes as a failed find with a note when the table was archived', async () => {
    const client = fakeClient([]);
    const result = await mark();
    expect(result).toMatchObject({ ok: true, result: { status: 'failed', lines: [] } });
    const update = client.query.mock.calls.find(([sql]) => /UPDATE finds SET status = 'failed'/.test(sql as string));
    expect(update?.[1]).toEqual([FIND, expect.stringContaining('archived')]);
  });

  it('closes as a failed find with a note when nothing on the table is pickable', async () => {
    const client = fakeClient([{ type_die: 6 }], []);
    const result = await mark();
    expect(result).toMatchObject({ ok: true, result: { status: 'failed', lines: [] } });
    expect(client.query.mock.calls.some(([sql]) => /UPDATE finds SET status = 'failed'/.test(sql as string))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO character_inventory_items/.test(sql as string))).toBe(false);
  });
});
