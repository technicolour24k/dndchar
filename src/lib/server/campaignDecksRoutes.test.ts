import { beforeEach, describe, expect, it, vi } from 'vitest';

// The campaign deck management page (decks unit 9b) with the services mocked: access is canManage, load and every
// action forward the signed-in user and the URL campaign (never a posted one), service errors become inline form
// errors, and a successful create or copy redirects to the editor. Ownership rules are in the gated DB test.

const getCampaignAccess = vi.fn();
vi.mock('$lib/server/services/access', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/access')>()),
  getCampaignAccess: (...args: unknown[]) => getCampaignAccess(...args)
}));
const query = vi.fn();
vi.mock('$lib/server/db', () => ({ query: (...a: unknown[]) => query(...a), withTransaction: vi.fn() }));
class MockDeckError extends Error { constructor(public code: string, message: string) { super(message); } }
const deckSvc = {
  DeckError: MockDeckError,
  createDeck: vi.fn(), copyDeckToCampaign: vi.fn(), updateDeck: vi.fn(), toggleDeckArchived: vi.fn(), dryRunDraw: vi.fn(),
  getOwnDeck: vi.fn(), listDecksForManagement: vi.fn(), setCampaignDeck: vi.fn(), saveDeckToLibrary: vi.fn()
};
vi.mock('$lib/server/services/decks', () => deckSvc);

const page = await import('../../routes/campaigns/[id]/decks/+page.server');

const ME = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const locals = { user: { id: ME, role: 'user' } };
const form = (fields: Record<string, string>) => ({ formData: async () => new URLSearchParams(fields) }) as unknown as Request;
const run = (action: any, fields: Record<string, string>) => action({ request: form(fields), params: { id: CAMPAIGN }, locals });
async function redirected(promise: Promise<unknown>) {
  try { await promise; } catch (error: any) { return { status: error.status, location: error.location }; }
  return null;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('/campaigns/[id]/decks load', () => {
  const load = (search = '') => (page.load as any)({ params: { id: CAMPAIGN }, locals, url: new URL(`http://x/campaigns/${CAMPAIGN}/decks${search}`) });

  it('refuses a player (403) and a stranger (404)', async () => {
    getCampaignAccess.mockResolvedValue({ canManage: false, archived: false });
    await expect(load()).rejects.toMatchObject({ status: 403 });
    getCampaignAccess.mockResolvedValue(null);
    await expect(load()).rejects.toMatchObject({ status: 404 });
    expect(deckSvc.listDecksForManagement).not.toHaveBeenCalled();
  });

  it('gives a DM the lists and the selected deck', async () => {
    getCampaignAccess.mockResolvedValue({ canManage: true, archived: false });
    query.mockResolvedValue({ rows: [{ name: 'Camp' }] });
    deckSvc.listDecksForManagement.mockResolvedValue({ own: [], global: [], library: [], canSaveToLibrary: true });
    deckSvc.getOwnDeck.mockResolvedValue({ id: 'd1' });
    const out: any = await load('?deck=d1');
    expect(deckSvc.listDecksForManagement).toHaveBeenCalledWith(ME, CAMPAIGN);
    expect(deckSvc.getOwnDeck).toHaveBeenCalledWith(ME, CAMPAIGN, 'd1');
    expect(out).toMatchObject({ campaignName: 'Camp', archived: false, selected: { id: 'd1' } });
  });
});

describe('/campaigns/[id]/decks actions', () => {
  it('create and copy forward the user and URL campaign, then redirect to the new deck', async () => {
    deckSvc.createDeck.mockResolvedValue('new1');
    const created = await redirected(run(page.actions.create, { name: 'Mine', description: 'd', campaignId: 'forged' }));
    expect(deckSvc.createDeck).toHaveBeenCalledWith({ userId: ME, campaignId: CAMPAIGN, name: 'Mine', description: 'd' });
    expect(created).toEqual({ status: 303, location: `/campaigns/${CAMPAIGN}/decks?deck=new1` });
    deckSvc.copyDeckToCampaign.mockResolvedValue('copy1');
    const copied = await redirected(run(page.actions.copy, { sourceId: 'seed' }));
    expect(deckSvc.copyDeckToCampaign).toHaveBeenCalledWith({ userId: ME, campaignId: CAMPAIGN, sourceId: 'seed' });
    expect(copied?.location).toBe(`/campaigns/${CAMPAIGN}/decks?deck=copy1`);
  });

  it('turns service errors into form failures with the right status', async () => {
    deckSvc.createDeck.mockRejectedValue(new MockDeckError('forbidden', 'Only the DM can manage this campaign\'s decks.'));
    const denied: any = await run(page.actions.create, { name: 'x' });
    expect(denied.status).toBe(403);
    deckSvc.copyDeckToCampaign.mockRejectedValue(new MockDeckError('not_found', 'Deck not found.'));
    expect(((await run(page.actions.copy, { sourceId: 'x' })) as any).status).toBe(404);
  });

  it('save keeps the typed text when the rules are refused, and reports success otherwise', async () => {
    deckSvc.updateDeck.mockResolvedValue({ ok: false, errors: ['bad'] });
    const refused: any = await run(page.actions.save, { id: 'd1', name: 'n', description: 'd', rulesText: '{x' });
    expect(refused.status).toBe(400);
    expect(refused.data).toMatchObject({ saveErrors: ['bad'], draft: { rulesText: '{x' } });
    expect(deckSvc.updateDeck).toHaveBeenCalledWith({ userId: ME, campaignId: CAMPAIGN, id: 'd1', name: 'n', description: 'd', rulesText: '{x' });
    deckSvc.updateDeck.mockResolvedValue({ ok: true, warnings: ['w'] });
    expect(await run(page.actions.save, { id: 'd1', name: 'n', description: 'd', rulesText: '{}' })).toEqual({ saved: 'd1', warnings: ['w'] });
  });

  it('setEnabled and saveToLibrary forward the user and URL campaign, and map errors', async () => {
    deckSvc.setCampaignDeck.mockResolvedValue(undefined);
    expect(await run(page.actions.setEnabled, { deckId: 'lib1', enabled: '1', campaignId: 'forged' })).toEqual({ enabledChanged: true });
    expect(deckSvc.setCampaignDeck).toHaveBeenCalledWith({ userId: ME, campaignId: CAMPAIGN, deckId: 'lib1', enabled: true });
    await run(page.actions.setEnabled, { deckId: 'lib1', enabled: '0' });
    expect(deckSvc.setCampaignDeck).toHaveBeenLastCalledWith({ userId: ME, campaignId: CAMPAIGN, deckId: 'lib1', enabled: false });
    deckSvc.setCampaignDeck.mockRejectedValue(new MockDeckError('not_found', 'Deck not found.'));
    expect(((await run(page.actions.setEnabled, { deckId: 'x', enabled: '1' })) as any).status).toBe(404);

    deckSvc.saveDeckToLibrary.mockResolvedValue('personal1');
    expect(await run(page.actions.saveToLibrary, { id: 'd1' })).toEqual({ savedToLibrary: 'personal1' });
    expect(deckSvc.saveDeckToLibrary).toHaveBeenCalledWith({ userId: ME, campaignId: CAMPAIGN, deckId: 'd1' });
    deckSvc.saveDeckToLibrary.mockRejectedValue(new MockDeckError('forbidden', 'Decks are for DMs and admins.'));
    expect(((await run(page.actions.saveToLibrary, { id: 'd1' })) as any).status).toBe(403);
  });

  it('archive and test draw forward the campaign scope', async () => {
    deckSvc.toggleDeckArchived.mockResolvedValue(true);
    await run(page.actions.archive, { id: 'd1', archived: '1' });
    expect(deckSvc.toggleDeckArchived).toHaveBeenCalledWith({ userId: ME, campaignId: CAMPAIGN, id: 'd1', archived: true });
    deckSvc.toggleDeckArchived.mockResolvedValue(false);
    expect(((await run(page.actions.archive, { id: 'other', archived: '1' })) as any).status).toBe(404);
    deckSvc.dryRunDraw.mockResolvedValue({ lines: ['ok'] });
    expect(await run(page.actions.testDraw, { id: 'd1', cardId: 'c1', success: 'failure', value: '11' })).toEqual({ testLines: ['ok'] });
    expect(deckSvc.dryRunDraw).toHaveBeenCalledWith({ userId: ME, campaignId: CAMPAIGN, id: 'd1', cardId: 'c1', success: 'failure', value: 11 });
  });
});
