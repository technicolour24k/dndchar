import { beforeEach, describe, expect, it, vi } from 'vitest';

// The campaign member-libraries page (homebrew library unit D1) with the services mocked: members can read it, a
// stranger gets 404, and only canManage (the DM, co-DM or an admin) may switch a library, checked on the route
// itself so a forged POST from a player is a 403 whatever the service does. The service rules are in the gated DB test.

const getCampaignAccess = vi.fn();
vi.mock('$lib/server/services/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/access')>()),
  getCampaignAccess: (...args: unknown[]) => getCampaignAccess(...args)
}));
vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
const loadCampaignLibraryPage = vi.fn();
const setCampaignLibrary = vi.fn();
vi.mock('$lib/server/services/library', () => ({
  loadCampaignLibraryPage: (...a: unknown[]) => loadCampaignLibraryPage(...a),
  setCampaignLibrary: (...a: unknown[]) => setCampaignLibrary(...a)
}));

const page = await import('../../routes/campaigns/[id]/library/+page.server');
const { CampaignError } = await import('$lib/server/campaignError');

const ME = '11111111-1111-4111-8111-111111111111';
const OWNER = '33333333-3333-4333-8333-333333333333';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const locals = { user: { id: ME, role: 'user' } };
const post = (fields: Record<string, string>) =>
  (page.actions as any).setLibrary({ request: { formData: async () => new URLSearchParams(fields) }, params: { id: CAMPAIGN }, locals });

beforeEach(() => vi.resetAllMocks());

describe('/campaigns/[id]/library load', () => {
  const load = () => (page.load as any)({ params: { id: CAMPAIGN }, locals });
  it('gives members the list and a stranger a 404', async () => {
    loadCampaignLibraryPage.mockResolvedValue({ campaignId: CAMPAIGN, members: [], canManage: false });
    expect(await load()).toMatchObject({ canManage: false });
    expect(loadCampaignLibraryPage).toHaveBeenCalledWith(expect.anything(), ME, CAMPAIGN);
    loadCampaignLibraryPage.mockResolvedValue(null);
    await expect(load()).rejects.toMatchObject({ status: 404 });
  });
});

describe('/campaigns/[id]/library setLibrary', () => {
  it('refuses a player with 403 and a stranger with 404, without touching the service', async () => {
    getCampaignAccess.mockResolvedValue({ canView: true, canManage: false, archived: false });
    await expect(post({ ownerUserId: OWNER, enabled: '1' })).rejects.toMatchObject({ status: 403 });
    getCampaignAccess.mockResolvedValue(null);
    await expect(post({ ownerUserId: OWNER, enabled: '1' })).rejects.toMatchObject({ status: 404 });
    expect(setCampaignLibrary).not.toHaveBeenCalled();
  });

  it('lets a DM (or the admin override) switch a library on and off using the URL campaign', async () => {
    getCampaignAccess.mockResolvedValue({ canView: true, canManage: true, archived: false });
    expect(await post({ ownerUserId: OWNER, enabled: '1' })).toEqual({ saved: true });
    expect(setCampaignLibrary).toHaveBeenLastCalledWith(ME, CAMPAIGN, OWNER, true);
    await post({ ownerUserId: OWNER, enabled: '0' });
    expect(setCampaignLibrary).toHaveBeenLastCalledWith(ME, CAMPAIGN, OWNER, false);
  });

  it('turns a refusal (archived campaign, non-member) into an inline error', async () => {
    getCampaignAccess.mockResolvedValue({ canView: true, canManage: true, archived: true });
    setCampaignLibrary.mockRejectedValue(new CampaignError('This campaign is archived, so its libraries can no longer be changed.'));
    const result: any = await post({ ownerUserId: OWNER, enabled: '1' });
    expect(result.status).toBe(400);
    expect(result.data.error).toContain('archived');
  });
});
