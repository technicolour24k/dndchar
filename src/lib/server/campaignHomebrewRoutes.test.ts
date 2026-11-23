import { beforeEach, describe, expect, it, vi } from 'vitest';

// The campaign copies page (homebrew library unit G3) with the services mocked: DM / co-DM / admin only, checked on the
// route itself in load and in every action (a player is 403, a stranger 404), and there is no `create` action at all,
// because a campaign copy is only ever made by a fork. The service rules are in the gated libraryFork test.

const getCampaignAccess = vi.fn();
vi.mock('$lib/server/services/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/access')>()),
  getCampaignAccess: (...args: unknown[]) => getCampaignAccess(...args)
}));
const dbQuery = vi.fn();
vi.mock('$lib/server/db', () => ({ query: (...a: unknown[]) => dbQuery(...a), withTransaction: vi.fn() }));
const loadCampaignHomebrew = vi.fn();
const updateCampaignEntry = vi.fn();
const otherWriters = [
  'toggleCampaignEntryArchive', 'campaignAttachModifier', 'campaignDetachModifier', 'campaignAttachEffect', 'campaignDetachEffect',
  'campaignAddResource', 'campaignGrantContent', 'campaignAddAction', 'campaignRemoveActionStep', 'campaignAttachAction', 'campaignDetachAction',
  'campaignAddSpellAccess', 'campaignRemoveSpellAccess', 'saveCampaignCondition', 'attachCampaignConditionModifier', 'detachCampaignConditionModifier'
];
vi.mock('$lib/server/services/library-campaign', () => ({
  parseHomebrewTab: (value: string | null) => (value === 'spell' || value === 'feat' || value === 'condition' ? value : 'item'),
  homebrewTabForType: (type: string) => (type === 'spell' ? 'spell' : type === 'condition' ? 'condition' : type === 'item' ? 'item' : 'feat'),
  loadCampaignHomebrew: (...a: unknown[]) => loadCampaignHomebrew(...a),
  updateCampaignEntry: (...a: unknown[]) => updateCampaignEntry(...a),
  ...Object.fromEntries(otherWriters.map((name) => [name, vi.fn()]))
}));

const page = await import('../../routes/campaigns/[id]/homebrew/+page.server');

const ME = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const ENTRY = '44444444-4444-4444-8444-444444444444';
const locals = { user: { id: ME, role: 'user' } };

beforeEach(() => vi.resetAllMocks());

describe('/campaigns/[id]/homebrew load', () => {
  const load = (search = '') => (page.load as any)({ params: { id: CAMPAIGN }, locals, url: new URL(`http://x/campaigns/${CAMPAIGN}/homebrew${search}`) });

  it('gives a DM the page, a player 403 and a stranger 404', async () => {
    loadCampaignHomebrew.mockResolvedValue({ status: 'ok', data: { tab: 'item', content: [] } });
    expect(await load()).toMatchObject({ tab: 'item' });
    expect(loadCampaignHomebrew).toHaveBeenLastCalledWith(ME, CAMPAIGN, 'item', '');
    await load('?type=condition&content=abc');
    expect(loadCampaignHomebrew).toHaveBeenLastCalledWith(ME, CAMPAIGN, 'condition', 'abc');
    loadCampaignHomebrew.mockResolvedValue({ status: 'forbidden' });
    await expect(load()).rejects.toMatchObject({ status: 403 });
    loadCampaignHomebrew.mockResolvedValue({ status: 'missing' });
    await expect(load()).rejects.toMatchObject({ status: 404 });
  });
});

describe('/campaigns/[id]/homebrew actions', () => {
  const post = (name: string, fields: Record<string, string> = { contentId: ENTRY }) =>
    (page.actions as any)[name]({ request: { formData: async () => new URLSearchParams(fields) }, params: { id: CAMPAIGN }, locals });

  it('has no create action: a copy is only ever made by a fork', () => {
    expect(Object.keys(page.actions)).not.toContain('create');
    expect((page.actions as any).create).toBeUndefined();
  });

  it('refuses a player with 403 and a stranger with 404 in every action, before touching a service', async () => {
    for (const name of Object.keys(page.actions)) {
      getCampaignAccess.mockResolvedValue({ canView: true, canManage: false, archived: false });
      await expect(post(name), name).rejects.toMatchObject({ status: 403 });
      getCampaignAccess.mockResolvedValue(null);
      await expect(post(name), name).rejects.toMatchObject({ status: 404 });
    }
    expect(updateCampaignEntry).not.toHaveBeenCalled();
  });

  it('lets a DM (or the admin override) write, using the URL campaign, and redirects back to the entry', async () => {
    getCampaignAccess.mockResolvedValue({ canView: true, canManage: true, archived: false });
    updateCampaignEntry.mockResolvedValue(ENTRY);
    dbQuery.mockResolvedValue({ rows: [{ content_type: 'spell' }] });
    await expect(post('update', { contentId: ENTRY, name: 'x' })).rejects.toMatchObject({ status: 303, location: `/campaigns/${CAMPAIGN}/homebrew?type=spell&content=${ENTRY}` });
    expect(updateCampaignEntry).toHaveBeenCalledWith(ME, CAMPAIGN, expect.anything());
  });

  it('turns a service refusal into an inline error', async () => {
    getCampaignAccess.mockResolvedValue({ canView: true, canManage: true, archived: false });
    updateCampaignEntry.mockRejectedValue(new Error('Campaign entry not found.'));
    const result: any = await post('update', { contentId: ENTRY });
    expect(result.status).toBe(400);
    expect(result.data.error).toBe('Campaign entry not found.');
  });
});
