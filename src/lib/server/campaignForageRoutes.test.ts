import { beforeEach, describe, expect, it, vi } from 'vitest';

// The campaign forage page (homebrew library unit H) with the services mocked: DM / co-DM / admin only, checked on the
// route itself in load and in every action (a player is 403, a stranger 404), the campaign always comes from the URL,
// and a table id from another campaign is refused. The table rules themselves are in the gated forage suite.

const getCampaignAccess = vi.fn();
vi.mock('$lib/server/services/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/access')>()),
  getCampaignAccess: (...args: unknown[]) => getCampaignAccess(...args)
}));
const dbQuery = vi.fn();
vi.mock('$lib/server/db', () => ({ query: (...a: unknown[]) => dbQuery(...a), withTransaction: vi.fn() }));
const createFindTable = vi.fn();
const updateFindTable = vi.fn();
const getFindTableCampaignId = vi.fn();
const listFindTables = vi.fn();
const otherWriters = ['toggleFindTableArchived', 'addFindTableEntry', 'updateFindTableEntries', 'removeFindTableEntry'];
vi.mock('$lib/server/services/forage', () => ({
  loadForageActor: vi.fn(async (user: { id: string }) => ({ id: user.id, role: 'user', dmCampaignIds: [] })),
  tablesForActor: (_actor: unknown, tables: unknown[]) => tables.map((t: any) => ({ ...t, canEdit: true })),
  listFindTables: (...a: unknown[]) => listFindTables(...a),
  getFindTableEntries: vi.fn(async () => []),
  getFindTableCampaignId: (...a: unknown[]) => getFindTableCampaignId(...a),
  createFindTable: (...a: unknown[]) => createFindTable(...a),
  updateFindTable: (...a: unknown[]) => updateFindTable(...a),
  ...Object.fromEntries(otherWriters.map((name) => [name, vi.fn()]))
}));

const page = await import('../../routes/campaigns/[id]/forage/+page.server');

const ME = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const OTHER = '99999999-9999-4999-8999-999999999999';
const TABLE = '33333333-3333-4333-8333-333333333333';
const locals = { user: { id: ME, role: 'user' } };
const dm = { canView: true, canManage: true, archived: false };

beforeEach(() => vi.resetAllMocks());

describe('/campaigns/[id]/forage load', () => {
  const load = (search = '') => (page.load as any)({ params: { id: CAMPAIGN }, locals, url: new URL(`http://x/campaigns/${CAMPAIGN}/forage${search}`) });

  it('gives a DM this campaign tables only, a player 403 and a stranger 404', async () => {
    getCampaignAccess.mockResolvedValue(dm);
    dbQuery.mockResolvedValue({ rows: [{ name: 'Camp' }] });
    listFindTables.mockResolvedValue([{ id: TABLE, areaType: 'meadow', category: 'plant' }]);
    const data = await load(`?table=${TABLE}`);
    expect(listFindTables).toHaveBeenCalledWith(expect.anything(), CAMPAIGN);
    expect(data).toMatchObject({ campaignId: CAMPAIGN, campaignName: 'Camp', selected: { id: TABLE } });
    getCampaignAccess.mockResolvedValue({ canView: true, canManage: false, archived: false });
    await expect(load()).rejects.toMatchObject({ status: 403 });
    getCampaignAccess.mockResolvedValue({ canView: false, canManage: false, archived: false });
    await expect(load()).rejects.toMatchObject({ status: 404 });
    getCampaignAccess.mockResolvedValue(null);
    await expect(load()).rejects.toMatchObject({ status: 404 });
  });
});

describe('/campaigns/[id]/forage actions', () => {
  const post = (name: string, fields: Record<string, string> = { tableId: TABLE }) =>
    (page.actions as any)[name]({
      request: { formData: async () => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return f; } },
      params: { id: CAMPAIGN }, locals
    });

  it('refuses a player with 403 and a stranger with 404 in every action, before touching a service', async () => {
    for (const name of Object.keys(page.actions)) {
      getCampaignAccess.mockResolvedValue({ canView: true, canManage: false, archived: false });
      await expect(post(name), name).rejects.toMatchObject({ status: 403 });
      getCampaignAccess.mockResolvedValue({ canView: false, canManage: false, archived: false });
      await expect(post(name), name).rejects.toMatchObject({ status: 404 });
    }
    expect(createFindTable).not.toHaveBeenCalled();
    expect(updateFindTable).not.toHaveBeenCalled();
  });

  it('createTable uses the URL campaign whatever the form says, then redirects to the new table', async () => {
    getCampaignAccess.mockResolvedValue(dm);
    createFindTable.mockResolvedValue(TABLE);
    await expect(post('createTable', { campaignId: OTHER, name: 'x' }))
      .rejects.toMatchObject({ status: 303, location: `/campaigns/${CAMPAIGN}/forage?table=${TABLE}` });
    expect(createFindTable.mock.calls[0][1].get('campaignId')).toBe(CAMPAIGN);
  });

  it('refuses a table from another campaign (or a missing one) without calling the service', async () => {
    getCampaignAccess.mockResolvedValue(dm);
    getFindTableCampaignId.mockResolvedValue(OTHER);
    expect(await post('updateTable')).toMatchObject({ status: 400, data: { error: 'Find table not found.' } });
    getFindTableCampaignId.mockResolvedValue(null);
    expect(await post('updateTable')).toMatchObject({ status: 400 });
    expect(updateFindTable).not.toHaveBeenCalled();
  });

  it('lets a DM edit a table of this campaign and redirects back to it; a service error comes back as a 400', async () => {
    getCampaignAccess.mockResolvedValue(dm);
    getFindTableCampaignId.mockResolvedValue(CAMPAIGN);
    updateFindTable.mockResolvedValue(TABLE);
    await expect(post('updateTable')).rejects.toMatchObject({ status: 303, location: `/campaigns/${CAMPAIGN}/forage?table=${TABLE}` });
    updateFindTable.mockRejectedValue(new Error('Nope.'));
    expect(await post('updateTable')).toMatchObject({ status: 400, data: { error: 'Nope.' } });
  });
});
