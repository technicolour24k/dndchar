import { beforeEach, describe, expect, it, vi } from 'vitest';

// Campaign scoping for the forage helpers (find tables belong to campaigns, Unit G): the DM's table
// pick must be in the ROOM'S campaign, a Quick room has no usable table, and the self-serve table is
// looked up in the character's own campaign only. DB mocked.

const tableOf = (id: string, campaignId: string, areaType: string, category: string, pickableCount = 3) =>
  ({ id, campaignId, name: id, areaType, category, pickableCount, isArchived: false, entries: [] });
const catalogue = { tables: [tableOf('t-a', 'camp1', 'meadow', 'plant'), tableOf('t-b', 'camp2', 'meadow', 'plant'), tableOf('t-empty', 'camp1', 'swamp', 'gem', 0)] };

vi.mock('$lib/server/db', () => ({ query: vi.fn() }));
vi.mock('$lib/server/services/forage', () => ({
  loadForageCatalogue: async () => catalogue,
  getActiveTable: async (id: string) => catalogue.tables.find((t) => t.id === id) ?? null
}));

const { parseChoice, parseSelfChoice, checkForageAvailability } = await import('./vttForageApi');

const gmBody = (tableId: string) => ({ skillKey: 'nature', tableId, areaType: 'meadow', category: 'plant' });

beforeEach(() => vi.clearAllMocks());

describe('parseChoice (the DM picks the table)', () => {
  it("accepts a table of the room's campaign", async () => {
    const out: any = await parseChoice(gmBody('t-a'), 'camp1');
    expect(out.choice.tableId).toBe('t-a');
  });

  it("refuses another campaign's table, and every table in a Quick room", async () => {
    expect(await parseChoice(gmBody('t-b'), 'camp1')).toEqual({ error: 'bad_table' });
    expect(await parseChoice(gmBody('t-a'), null)).toEqual({ error: 'bad_table' });
  });

  it("still says table_empty for the room's own empty table, and bad_table for an unknown one", async () => {
    expect(await parseChoice(gmBody('t-empty'), 'camp1')).toEqual({ error: 'table_empty' });
    expect(await parseChoice(gmBody('nope'), 'camp1')).toEqual({ error: 'bad_table' });
  });
});

describe('parseSelfChoice (the server resolves the table)', () => {
  const body = { skillKey: 'nature', areaType: 'meadow', category: 'plant' };

  it("finds the table in the character's campaign, never another's", async () => {
    expect((await parseSelfChoice(body, 'camp1') as any).choice.tableId).toBe('t-a');
    expect((await parseSelfChoice(body, 'camp2') as any).choice.tableId).toBe('t-b');
  });

  it('gives no table (a pass finds nothing) for a campaign with no such combination', async () => {
    expect((await parseSelfChoice(body, 'camp3') as any).choice.tableId).toBeNull();
    expect((await parseSelfChoice({ ...body, areaType: 'swamp', category: 'gem' }, 'camp1') as any).choice.tableId).toBeNull(); // empty table
  });
});

describe('checkForageAvailability', () => {
  it('combines the character campaign, the live room and the campaign tables', async () => {
    expect(await checkForageAvailability({ campaignId: 'camp1' }, null)).toEqual({ available: true });
    expect(await checkForageAvailability({ campaignId: 'camp1' }, { campaignId: 'camp1' })).toEqual({ available: true });
    expect(await checkForageAvailability({ campaignId: 'camp1' }, { campaignId: null })).toEqual({ available: false, reason: 'wrong_room' });
    expect(await checkForageAvailability({ campaignId: null }, null)).toEqual({ available: false, reason: 'no_campaign' });
    expect(await checkForageAvailability({ campaignId: 'camp3' }, null)).toEqual({ available: false, reason: 'no_tables' });
  });
});
