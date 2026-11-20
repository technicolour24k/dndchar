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
const C1 = '55555555-5555-4555-8555-555555555555';
const C2 = '66666666-6666-4666-8666-666666666666';
// user = a DM of campaign C1; admin = site admin (no DM role anywhere); player = in no DM seat at all.
const user = { id: 'u1', role: 'user' as const, dmCampaignIds: [C1] };
const admin = { id: 'a1', role: 'admin' as const, dmCampaignIds: [] as string[] };
const player = { id: 'u3', role: 'user' as const, dmCampaignIds: [] as string[] };
const otherDm = { id: 'u4', role: 'user' as const, dmCampaignIds: [C2] };

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
  it("allows a DM or co-DM of the table's campaign and admins, nobody else", () => {
    expect(canEditFindTable(user, { campaignId: C1 })).toBe(true); // primary DM or co-DM (both are in dmCampaignIds)
    expect(canEditFindTable(player, { campaignId: C1 })).toBe(false); // a plain player
    expect(canEditFindTable(otherDm, { campaignId: C1 })).toBe(false); // another campaign's DM
    expect(canEditFindTable(admin, { campaignId: C1 })).toBe(true);
  });
  it('ignores who wrote the table', () => {
    // The author who is no longer a DM (or never was) gets nothing: the table has no author field in the check.
    expect(canEditFindTable(player, { campaignId: C1, ownerUserId: 'u3' } as any)).toBe(false);
  });
});

describe('createFindTable', () => {
  const fields = { name: 'Meadow - plants', areaType: 'Meadow', category: 'plant', campaignId: C1 };
  const campaignRow = { rows: [{ name: 'Main Campaign', is_archived: false }], rowCount: 1 } as any;

  it('stores normalised tags in the campaign, with the creator as provenance', async () => {
    queryMock.mockResolvedValueOnce(campaignRow).mockResolvedValueOnce({ rows: [{ id: T1 }], rowCount: 1 } as any);
    expect(await createFindTable(user, form(fields))).toBe(T1);
    expect(queryMock.mock.calls[1][1]).toEqual(['Meadow - plants', 'meadow', 'plant', '', 'u1', C1]);
  });

  it('maps a unique violation to the friendly message, naming the campaign', async () => {
    queryMock.mockResolvedValueOnce(campaignRow).mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }));
    await expect(createFindTable(user, form(fields))).rejects.toThrow("There's already an active table for meadow + plant in Main Campaign.");
  });

  it("needs a campaign the actor is a DM of (a player, another campaign's DM and a missing campaign all fail before any write)", async () => {
    await expect(createFindTable(player, form(fields))).rejects.toThrow(/DM of/);
    await expect(createFindTable(otherDm, form(fields))).rejects.toThrow(/DM of/);
    await expect(createFindTable(user, form({ ...fields, campaignId: '' }))).rejects.toThrow(/Pick a campaign/);
    expect(queryMock).not.toHaveBeenCalled();
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    await expect(createFindTable(admin, form(fields))).rejects.toThrow(/not found/);
  });

  it('lets an admin create in any live campaign, and refuses an archived one', async () => {
    queryMock.mockResolvedValueOnce(campaignRow).mockResolvedValueOnce({ rows: [{ id: T1 }], rowCount: 1 } as any);
    expect(await createFindTable(admin, form({ ...fields, campaignId: C2 }))).toBe(T1);
    queryMock.mockResolvedValueOnce({ rows: [{ name: 'Old', is_archived: true }], rowCount: 1 } as any);
    await expect(createFindTable(admin, form(fields))).rejects.toThrow(/not found/);
  });
});

describe('editing permissions', () => {
  it("refuses anyone who isn't a DM of the table's campaign before writing anything", async () => {
    queryMock.mockResolvedValue({ rows: [{ campaign_id: C2 }], rowCount: 1 } as any);
    await expect(updateFindTable(user, form({ tableId: T1, name: 'x', areaType: 'a', category: 'b', suggestedCheck: '' })))
      .rejects.toThrow(/Only a DM of this table's campaign/);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('lets a co-DM (same dmCampaignIds) and an admin through the gate', async () => {
    queryMock.mockResolvedValue({ rows: [{ campaign_id: C1 }], rowCount: 1 } as any);
    await updateFindTable(user, form({ tableId: T1, name: 'x', areaType: 'a', category: 'b', suggestedCheck: '' }));
    await updateFindTable(admin, form({ tableId: T1, name: 'x', areaType: 'a', category: 'b', suggestedCheck: '' }));
    expect(queryMock).toHaveBeenCalledTimes(4); // gate + update, twice
  });

  it('refuses to add an archived item', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ campaign_id: C1 }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [{ is_archived: true }], rowCount: 1 } as any);
    await expect(addFindTableEntry(user, form({ tableId: T1, itemId: I1, chance: '30', qtyDie: '1' })))
      .rejects.toThrow(/archived/);
  });

  it('refuses a content row that is not an item', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{ campaign_id: C1 }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any);
    await expect(addFindTableEntry(user, form({ tableId: T1, itemId: I1, chance: '30', qtyDie: '1' })))
      .rejects.toThrow(/not an item/);
  });
});

describe('more write rules', () => {
  const owned = { rows: [{ campaign_id: C1 }], rowCount: 1 } as any;

  it('refuses a repeat add instead of overwriting the tuned entry', async () => {
    queryMock
      .mockResolvedValueOnce(owned)
      .mockResolvedValueOnce({ rows: [{ is_archived: false }], rowCount: 1 } as any)
      .mockResolvedValueOnce({ rows: [], rowCount: 0 } as any); // ON CONFLICT DO NOTHING inserted nothing
    await expect(addFindTableEntry(user, form({ tableId: T1, itemId: I1, chance: '30', qtyDie: '1' })))
      .rejects.toThrow('That item is already on this table.');
  });

  it('validates every entry before writing any', async () => {
    queryMock.mockResolvedValueOnce(owned);
    const data = new FormData();
    data.append('tableId', T1);
    data.append('entryItem', I1); data.append('chance', '30'); data.append('qtyDie', '2');
    data.append('entryItem', I2); data.append('chance', '30'); data.append('qtyDie', '0'); // bad
    await expect(updateFindTableEntries(user, data)).rejects.toThrow(/Quantity die/);
    expect(vi.mocked(withTransaction)).not.toHaveBeenCalled();
  });

  it('gives the friendly error when restoring an archived table hits the unique index', async () => {
    queryMock
      .mockResolvedValueOnce(owned)
      .mockRejectedValueOnce(Object.assign(new Error('dup'), { code: '23505' }))
      .mockResolvedValueOnce({ rows: [{ area_type: 'meadow', category: 'plant' }], rowCount: 1 } as any);
    await expect(toggleFindTableArchived(user, form({ tableId: T1 })))
      .rejects.toThrow("There's already an active table for meadow + plant in this campaign.");
  });

  it("refuses removeFindTableEntry for a player or another campaign's DM and never deletes", async () => {
    queryMock.mockResolvedValueOnce(owned);
    await expect(removeFindTableEntry(player, form({ tableId: T1, itemId: I1 }))).rejects.toThrow(/Only a DM/);
    queryMock.mockClear();
    queryMock.mockResolvedValueOnce(owned);
    await expect(removeFindTableEntry(otherDm, form({ tableId: T1, itemId: I1 }))).rejects.toThrow(/Only a DM/);
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
    id: T1, campaignId: C1, campaignName: 'Main Campaign', name: 'n', areaType: 'a', category: 'b', suggestedCheck: 'Nature DC 12', isArchived: false,
    ownerUserId: 'u1', ownerName: 'Me', entryCount: 0, pickableCount: 0
  };
  it("shows the suggested check to the campaign's DMs and admins only", () => {
    expect(tablesForActor(user, [base])[0]).toMatchObject({ canEdit: true, suggestedCheck: 'Nature DC 12' });
    expect(tablesForActor(admin, [base])[0].suggestedCheck).toBe('Nature DC 12');
    expect(tablesForActor(player, [base])[0]).toMatchObject({ canEdit: false, suggestedCheck: '' });
    expect(tablesForActor(otherDm, [base])[0]).toMatchObject({ canEdit: false, suggestedCheck: '' });
  });
});

describe('loadForageCatalogue', () => {
  it('runs two queries and counts pickable entries, flagging archived items', async () => {
    queryMock
      .mockResolvedValueOnce({ rows: [{
        id: T1, campaign_id: C1, campaign_name: null, name: 'Meadow', area_type: 'meadow', category: 'plant', suggested_check: 'Nature DC 12',
        is_archived: false, owner_user_id: null, owner_name: null, entry_count: 0, pickable_count: 0
      }] } as any)
      .mockResolvedValueOnce({ rows: [
        { find_table_id: T1, item_id: I1, item_name: 'Moonleaf', item_category: 'consumable', chance: 50, qty_die: 4, sort_order: 0, item_archived: false },
        { find_table_id: T1, item_id: I2, item_name: 'Stalk', item_category: 'consumable', chance: 30, qty_die: 2, sort_order: 1, item_archived: true },
        { find_table_id: T1, item_id: I3, item_name: 'Moss', item_category: 'consumable', chance: 0, qty_die: 3, sort_order: 2, item_archived: false }
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
  function fakeClient(tableRows: Array<Record<string, unknown>>, entryRows: unknown[] = []) {
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
    const client = fakeClient([{ '?column?': 1 }], []);
    const result = await mark();
    expect(result).toMatchObject({ ok: true, result: { status: 'failed', lines: [] } });
    expect(client.query.mock.calls.some(([sql]) => /UPDATE finds SET status = 'failed'/.test(sql as string))).toBe(true);
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO character_inventory_items/.test(sql as string))).toBe(false);
  });

  it('a pass where every d100 misses closes as a found find with no results', async () => {
    const entryRow = { find_table_id: T1, item_id: I1, item_name: 'Moonleaf', item_category: 'consumable', chance: 5, qty_die: 2, sort_order: 0, item_archived: false };
    const client = fakeClient([{ '?column?': 1 }], [entryRow]);
    const result = await markSelfFind({ findId: FIND, userId: 'u1', passed: true, rollDie: () => 100 });
    expect(result).toMatchObject({ ok: true, result: { status: 'found', lines: [] } });
    const update = client.query.mock.calls.find(([sql]) => /UPDATE finds SET status = 'found'/.test(sql as string));
    expect(update?.[1]).toEqual([FIND, T1, '[]']);
    expect(client.query.mock.calls.some(([sql]) => /INSERT INTO character_inventory_items/.test(sql as string))).toBe(false);
  });
});
