import { beforeEach, describe, expect, it, vi } from 'vitest';

// The personal deck page /library/decks (homebrew library unit E) with the services mocked: every action forwards only
// the signed-in user (never a posted owner), service errors become inline form errors, and a create redirects to the
// editor. The ownership and DM-tier rules themselves are in the gated libraryDecks.integration.test.ts.

const query = vi.fn();
vi.mock('$lib/server/db', () => ({ query: (...a: unknown[]) => query(...a), withTransaction: vi.fn() }));
const loadLibraryActor = vi.fn();
const countHolders = vi.fn();
vi.mock('$lib/server/services/library', () => ({
  loadLibraryActor: (...a: unknown[]) => loadLibraryActor(...a), countHolders: (...a: unknown[]) => countHolders(...a)
}));
class MockDeckError extends Error { constructor(public code: string, message: string) { super(message); } }
const deckSvc = {
  DeckError: MockDeckError,
  createPersonalDeck: vi.fn(), updatePersonalDeck: vi.fn(), togglePersonalDeckArchived: vi.fn(), dryRunPersonalDraw: vi.fn(),
  getPersonalDeck: vi.fn(), listPersonalDecks: vi.fn()
};
vi.mock('$lib/server/services/decks', () => deckSvc);

const page = await import('../../routes/library/decks/+page.server');
const libraryPage = await import('../../routes/library/+page.server');

const ME = '11111111-1111-4111-8111-111111111111';
const locals = { user: { id: ME, role: 'user' } };
const form = (fields: Record<string, string>) => ({ formData: async () => new URLSearchParams(fields) }) as unknown as Request;
const run = (action: any, fields: Record<string, string>) => action({ request: form(fields), locals });
async function redirected(promise: Promise<unknown>) {
  try { await promise; } catch (error: any) { return { status: error.status, location: error.location }; }
  return null;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe('/library/decks load', () => {
  const load = (search = '') => (page.load as any)({ locals, url: new URL(`http://x/library/decks${search}`) });

  it('lists the user\'s own decks and the selected one with its campaign count', async () => {
    loadLibraryActor.mockResolvedValue({ canAuthorMechanics: true });
    deckSvc.listPersonalDecks.mockResolvedValue([{ id: 'd1' }]);
    deckSvc.getPersonalDeck.mockResolvedValue({ id: 'd1' });
    countHolders.mockResolvedValue({ campaigns: 3 });
    const out: any = await load('?deck=d1');
    expect(deckSvc.listPersonalDecks).toHaveBeenCalledWith(ME);
    expect(deckSvc.getPersonalDeck).toHaveBeenCalledWith(ME, 'd1');
    expect(out).toMatchObject({ canAuthorMechanics: true, campaigns: 3, selected: { id: 'd1' } });
  });

  it('shows no editor and skips the count when nothing is selected', async () => {
    loadLibraryActor.mockResolvedValue({ canAuthorMechanics: false });
    deckSvc.listPersonalDecks.mockResolvedValue([]);
    const out: any = await load();
    expect(out).toMatchObject({ canAuthorMechanics: false, selected: null, campaigns: 0 });
    expect(countHolders).not.toHaveBeenCalled();
  });
});

describe('/library/decks actions', () => {
  it('create forwards only the signed-in user, then redirects to the new deck', async () => {
    deckSvc.createPersonalDeck.mockResolvedValue('new1');
    const created = await redirected(run(page.actions.create, { name: 'Mine', description: 'd', userId: 'forged' }));
    expect(deckSvc.createPersonalDeck).toHaveBeenCalledWith({ userId: ME, name: 'Mine', description: 'd' });
    expect(created).toEqual({ status: 303, location: '/library/decks?deck=new1' });
    deckSvc.createPersonalDeck.mockRejectedValue(new MockDeckError('forbidden', 'Decks are for DMs and admins.'));
    expect(((await run(page.actions.create, { name: 'x' })) as any).status).toBe(403);
  });

  it('save keeps the typed text when refused, and reports success otherwise', async () => {
    deckSvc.updatePersonalDeck.mockResolvedValue({ ok: false, errors: ['bad'] });
    const refused: any = await run(page.actions.save, { id: 'd1', name: 'n', description: 'd', rulesText: '{x' });
    expect(refused.status).toBe(400);
    expect(refused.data).toMatchObject({ saveErrors: ['bad'], draft: { rulesText: '{x' } });
    expect(deckSvc.updatePersonalDeck).toHaveBeenCalledWith({ userId: ME, id: 'd1', name: 'n', description: 'd', rulesText: '{x' });
    deckSvc.updatePersonalDeck.mockResolvedValue({ ok: true, warnings: ['w'] });
    expect(await run(page.actions.save, { id: 'd1', name: 'n', description: 'd', rulesText: '{}' })).toEqual({ saved: 'd1', warnings: ['w'] });
  });

  it('archive and test draw forward the user, and a deck that is not theirs is a 404', async () => {
    deckSvc.togglePersonalDeckArchived.mockResolvedValue(true);
    await run(page.actions.archive, { id: 'd1', archived: '1' });
    expect(deckSvc.togglePersonalDeckArchived).toHaveBeenCalledWith({ userId: ME, id: 'd1', archived: true });
    deckSvc.togglePersonalDeckArchived.mockResolvedValue(false);
    expect(((await run(page.actions.archive, { id: 'other', archived: '1' })) as any).status).toBe(404);
    deckSvc.dryRunPersonalDraw.mockResolvedValue({ lines: ['ok'] });
    expect(await run(page.actions.testDraw, { id: 'd1', cardId: 'c1', success: 'failure', value: '11' })).toEqual({ testLines: ['ok'] });
    expect(deckSvc.dryRunPersonalDraw).toHaveBeenCalledWith({ userId: ME, id: 'd1', cardId: 'c1', success: 'failure', value: 11 });
  });
});

describe('/library?type=deck', () => {
  it('redirects to the deck page', async () => {
    const out = await redirected((libraryPage.load as any)({ locals, url: new URL('http://x/library?type=deck') }));
    expect(out).toEqual({ status: 303, location: '/library/decks' });
  });
});
