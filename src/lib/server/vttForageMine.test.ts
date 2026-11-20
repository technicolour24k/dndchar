import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, sessions } from '../../../vtt/server/store.js';

// GET /vtt/api/forage/mine: owner-checked, and says whose pending forage it is. DB mocked.

const CHARACTER = '11111111-1111-4111-8111-111111111111';
const queryMock = vi.fn();
const unmarked = vi.fn();

vi.mock('$lib/server/db', () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock('$lib/server/services/forage', () => ({
  getUnmarkedSelfFind: (...args: unknown[]) => unmarked(...args),
  loadForageCatalogue: async () => ({ tables: [] }),
  getActiveTable: async () => null
}));

const route = await import('../../routes/vtt/api/forage/mine/+server');
const get = (userId: string) =>
  route.GET({ locals: { user: { id: userId } }, url: new URL(`http://localhost/x?characterId=${CHARACTER}`) } as any);

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  unmarked.mockResolvedValue(null);
});

describe('GET /vtt/api/forage/mine', () => {
  it('404s for a non-owner (the ownership query is scoped to the caller)', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await get('intruder')).status).toBe(404);
    expect(queryMock.mock.calls[0][1]).toEqual([CHARACTER, 'intruder']);
    expect(unmarked).not.toHaveBeenCalled();
  });

  it('returns the owner state with serverNow, and names the character behind a pending request', async () => {
    queryMock.mockResolvedValue({ rows: [{ name: 'Thorne', active_vtt_session_id: null }], rowCount: 1 });
    const room = createSession('R1');
    room.forage = { u1: { id: 'req', playerId: 'u1', characterId: 'c9', characterName: 'Mira', stage: 'requested', source: 'sheet', check: null } };
    sessions.set('R1', room);
    const body = await (await get('u1')).json();
    expect(typeof body.serverNow).toBe('number');
    expect(body.pending).toMatchObject({ id: 'req', stage: 'requested' });
    expect(body.pendingCharacter).toEqual({ id: 'c9', name: 'Mira' });
  });

  it('names the character behind an unmarked check', async () => {
    queryMock.mockResolvedValue({ rows: [{ name: 'Thorne', active_vtt_session_id: null }], rowCount: 1 });
    unmarked.mockResolvedValue({ findId: 'f1', characterId: 'c9', tableId: 't', check: {}, roomCode: null });
    const body = await (await get('u1')).json();
    expect(body.unmarkedSelf).toMatchObject({ findId: 'f1', characterId: 'c9', characterName: 'Thorne' });
    expect(body.unmarkedSelf.tableId).toBeUndefined();
  });
});
