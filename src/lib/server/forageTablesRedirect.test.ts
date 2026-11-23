import { beforeEach, describe, expect, it, vi } from 'vitest';

// The old /forage/tables address after unit H: it only redirects or lists, it never edits.
const getFindTableCampaignId = vi.fn();
const listEditableCampaigns = vi.fn();
vi.mock('$lib/server/services/forage', () => ({
  getFindTableCampaignId: (...a: unknown[]) => getFindTableCampaignId(...a),
  listEditableCampaigns: (...a: unknown[]) => listEditableCampaigns(...a),
  loadForageActor: vi.fn(async () => ({ id: 'u', role: 'user', dmCampaignIds: [] }))
}));
const getCampaignAccess = vi.fn();
vi.mock('$lib/server/services/access', () => ({ getCampaignAccess: (...a: unknown[]) => getCampaignAccess(...a) }));
vi.mock('$lib/server/db', () => ({ query: vi.fn() }));
const page = await import('../../routes/forage/tables/+page.server');
const TABLE = '33333333-3333-4333-8333-333333333333';
const load = (search = '') => (page.load as any)({ url: new URL(`http://x/forage/tables${search}`), locals: { user: { id: 'u', role: 'user' } } });

beforeEach(() => vi.resetAllMocks());

describe('/forage/tables', () => {
  it('sends ?table=<id> to the campaign page of that table', async () => {
    getFindTableCampaignId.mockResolvedValue('c1');
    getCampaignAccess.mockResolvedValue({ canView: true, canManage: true });
    await expect(load(`?table=${TABLE}`)).rejects.toMatchObject({ status: 302, location: `/campaigns/c1/forage?table=${TABLE}` });
  });

  it('does not redirect (or reveal the campaign) for someone who cannot manage it', async () => {
    getFindTableCampaignId.mockResolvedValue('c1');
    getCampaignAccess.mockResolvedValue({ canView: true, canManage: false });
    listEditableCampaigns.mockResolvedValue([]);
    expect((await load(`?table=${TABLE}`)).campaigns).toEqual([]);
  });

  it('sends a single-campaign DM straight to their page, lists several, and lists none for a non-DM', async () => {
    listEditableCampaigns.mockResolvedValue([{ id: 'c1', name: 'One' }]);
    await expect(load()).rejects.toMatchObject({ status: 302, location: '/campaigns/c1/forage' });
    listEditableCampaigns.mockResolvedValue([{ id: 'c1', name: 'One' }, { id: 'c2', name: 'Two' }]);
    expect((await load()).campaigns).toHaveLength(2);
    listEditableCampaigns.mockResolvedValue([]);
    expect((await load()).campaigns).toEqual([]);
    // An unknown table id falls back to the list rather than a 404.
    getFindTableCampaignId.mockResolvedValue(null);
    expect((await load(`?table=${TABLE}`)).campaigns).toEqual([]);
  });
});
