import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setWatches, watchersByTopic } from '../../../vtt/server/store.js';

// Unit D routes: share permission and one-way, admin-only undo/clear, and what a watcher socket can
// see. The database and the roll log are mocked; the real room store is used for the watcher check.

const shareFind = vi.fn();
const revertFind = vi.fn();
const clearUnmarkedCheck = vi.fn();
const listUnmarkedChecks = vi.fn();
const listFindsForGameSession = vi.fn();
const queryMock = vi.fn();
const logRoll = vi.fn();

vi.mock('$lib/server/db', () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('$lib/server/services/rollLog', () => ({ logRoll: (...args: unknown[]) => logRoll(...args) }));
vi.mock('$lib/server/services/characters', () => ({ getCharacterForRoll: vi.fn() }));
vi.mock('$lib/server/vttAttackAdvantage', () => ({ gatherVttAdvantageSources: vi.fn(), parseAttackOptions: vi.fn() }));
vi.mock('$lib/server/services/forage', () => ({
  shareFind: (...args: unknown[]) => shareFind(...args),
  revertFind: (...args: unknown[]) => revertFind(...args),
  clearUnmarkedCheck: (...args: unknown[]) => clearUnmarkedCheck(...args),
  listUnmarkedChecks: (...args: unknown[]) => listUnmarkedChecks(...args),
  listFindsForGameSession: (...args: unknown[]) => listFindsForGameSession(...args),
  listFindFilterOptions: async () => ({ sessions: [], characters: [] }),
  listFindsForAdmin: async () => [],
  ADMIN_FIND_STATUSES: ['all', 'dm', 'self', 'checked', 'failed', 'found', 'reverted']
}));

const { createSession, sessions } = await import('../../../vtt/server/store.js');
const shareRoute = await import('../../routes/vtt/api/finds/[id]/share/+server');
const findsRoute = await import('../../routes/vtt/api/game-sessions/[id]/finds/+server');
const adminRoute = await import('../../routes/vtt/api/forage/admin/+server');
const adminPage = await import('../../routes/admin/forage/+page.server');
const { publishFindChanged } = await import('./vttForageRoll');

const FIND = '22222222-2222-4222-8222-222222222222';
const GAME = '33333333-3333-4333-8333-333333333333';
const sharedFind = {
  findId: FIND, finderUserId: 'u1', characterId: 'c1', characterName: 'Thorne', roomCode: 'ROOM1', gameSessionId: GAME,
  lines: [{ name: 'Moonleaf', qty: 3 }, { name: 'Iron Ore', qty: 2 }]
};

const share = (userId = 'u1') => shareRoute.POST({ locals: { user: { id: userId } }, params: { id: FIND } } as any);
const adminPost = (role: 'admin' | 'user', body: unknown) =>
  adminRoute.POST({ locals: { user: { id: 'a1', role } }, request: { json: async () => body } } as any);

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  watchersByTopic.clear();
  sessions.set('ROOM1', createSession('ROOM1'));
  queryMock.mockResolvedValue({ rows: [{ name: 'Thorne' }], rowCount: 1 });
});

describe('POST /vtt/api/finds/[id]/share', () => {
  it('shares once: posts the share line with item names, and nudges Session Notes', async () => {
    shareFind.mockResolvedValue({ ok: true, alreadyShared: false, find: sharedFind });
    const res = await share();
    expect(res.status).toBe(200);
    expect(logRoll).toHaveBeenCalledTimes(1);
    expect(logRoll.mock.calls[0][1]).toBe('Thorne shared their find: Moonleaf x3, Iron Ore x2.');
    // The details carry a count and the find id, never names or item ids.
    const details = JSON.stringify(logRoll.mock.calls[0][2]);
    expect(details).not.toContain('Moonleaf');
    expect(details).not.toContain('item_id');
    expect(JSON.parse(details)).toMatchObject({ outcome: 'shared', itemCount: 5 });
  });

  it('marks the finder\'s in-room result as shared, so a reconnect does not offer Share again', async () => {
    sessions.get('ROOM1').forageResults = { u1: { requestId: 'r', findId: FIND, outcome: 'approved' } };
    shareFind.mockResolvedValue({ ok: true, alreadyShared: false, find: sharedFind });
    await share();
    expect(sessions.get('ROOM1').forageResults.u1.shared).toBe(true);
  });

  it('is one way and idempotent: a second share is 200 with no second line', async () => {
    shareFind.mockResolvedValue({ ok: true, alreadyShared: true });
    const res = await share();
    expect(res.status).toBe(200);
    expect(logRoll).not.toHaveBeenCalled();
  });

  it('refuses another account (403), an unknown find (404) and a failed or reverted one (409)', async () => {
    shareFind.mockResolvedValueOnce({ ok: false, error: 'forbidden' });
    expect((await share('intruder')).status).toBe(403);
    shareFind.mockResolvedValueOnce({ ok: false, error: 'not_found' });
    expect((await share()).status).toBe(404);
    shareFind.mockResolvedValueOnce({ ok: false, error: 'not_shareable' });
    const res = await share();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'not_shareable' });
    expect(logRoll).not.toHaveBeenCalled();
  });

  it('passes the caller\'s own id to the service (the owner check lives there)', async () => {
    shareFind.mockResolvedValue({ ok: false, error: 'forbidden' });
    await share('someone-else');
    expect(shareFind).toHaveBeenCalledWith(FIND, 'someone-else');
  });
});

describe('GET /vtt/api/game-sessions/[id]/finds', () => {
  it('passes the viewer (id and role) so the server shapes the rows, and flags admins', async () => {
    listFindsForGameSession.mockResolvedValue({ isDm: false, finds: [] });
    const res = await findsRoute.GET({ locals: { user: { id: 'u2', role: 'user' } }, params: { id: GAME } } as any);
    expect(listFindsForGameSession).toHaveBeenCalledWith(GAME, { id: 'u2', role: 'user' });
    expect(await res.json()).toMatchObject({ isAdmin: false });
  });
  it('404s an unknown game session', async () => {
    listFindsForGameSession.mockResolvedValue(null);
    expect((await findsRoute.GET({ locals: { user: { id: 'u2', role: 'user' } }, params: { id: GAME } } as any)).status).toBe(404);
  });
});

describe('admin undo and clear are admin-only', () => {
  it('refuses a non-admin on the endpoint (undo, clear and the list)', async () => {
    expect((await adminPost('user', { action: 'undo', findId: FIND })).status).toBe(403);
    expect((await adminPost('user', { action: 'clear', findId: FIND })).status).toBe(403);
    expect((await adminRoute.GET({ locals: { user: { id: 'u1', role: 'user' } } } as any)).status).toBe(403);
    expect(revertFind).not.toHaveBeenCalled();
    expect(clearUnmarkedCheck).not.toHaveBeenCalled();
  });

  it('refuses a non-admin on the page actions', async () => {
    const form = new FormData();
    form.set('findId', FIND);
    const event = { locals: { user: { id: 'u1', role: 'user' } }, request: { formData: async () => form } } as any;
    expect((await adminPage.actions.undoFind(event) as any).status).toBe(403);
    expect((await adminPage.actions.clearCheck(event) as any).status).toBe(403);
    expect(revertFind).not.toHaveBeenCalled();
    expect(clearUnmarkedCheck).not.toHaveBeenCalled();
  });

  it('undo as admin posts a name-free line, and the page action returns the revert note', async () => {
    revertFind.mockResolvedValue({ note: 'Moonleaf: removed', characterId: 'c1', finderUserId: 'u1', roomCode: 'ROOM1', gameSessionId: GAME });
    const form = new FormData();
    form.set('findId', FIND);
    const result: any = await adminPage.actions.undoFind({ locals: { user: { id: 'a1', role: 'admin' } }, request: { formData: async () => form } } as any);
    expect(result).toMatchObject({ undone: FIND, note: 'Moonleaf: removed' });
    expect(logRoll.mock.calls[0][1]).toBe("The DM undid Thorne's find.");
    expect(JSON.stringify(logRoll.mock.calls[0][2])).not.toContain('Moonleaf');
  });

  it('a second undo (nothing found) is refused, not an error page', async () => {
    revertFind.mockResolvedValue(null);
    const form = new FormData();
    form.set('findId', FIND);
    const result: any = await adminPage.actions.undoFind({ locals: { user: { id: 'a1', role: 'admin' } }, request: { formData: async () => form } } as any);
    expect(result.status).toBe(409);
  });

  it('the endpoint undo and clear work for an admin', async () => {
    revertFind.mockResolvedValue({ note: 'x', characterId: 'c1', finderUserId: 'u1', roomCode: null, gameSessionId: null });
    clearUnmarkedCheck.mockResolvedValue({ gameSessionId: GAME });
    expect((await adminPost('admin', { action: 'undo', findId: FIND })).status).toBe(200);
    expect((await adminPost('admin', { action: 'clear', findId: FIND })).status).toBe(200);
  });
});

describe('watcher-visible payloads carry no item names', () => {
  it('the game_session:find nudge is only a type and the find id', () => {
    const send = vi.fn();
    setWatches({ ws: { readyState: 1, OPEN: 1, send }, watchTopics: new Set() } as any, [`game-session:${GAME}`]);
    publishFindChanged(GAME, FIND);
    expect(send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(send.mock.calls[0][0])).toEqual({ type: 'game_session:find', findId: FIND, topic: `game-session:${GAME}` });
  });

  it('does nothing when the find has no game session', () => {
    const send = vi.fn();
    setWatches({ ws: { readyState: 1, OPEN: 1, send }, watchTopics: new Set() } as any, [`game-session:${GAME}`]);
    publishFindChanged(null, FIND);
    expect(send).not.toHaveBeenCalled();
  });
});
