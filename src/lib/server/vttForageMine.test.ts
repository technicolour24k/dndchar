import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, sessions } from '../../../vtt/server/store.js';

// GET /vtt/api/forage/mine: owner-checked, and says whose pending forage it is. DB mocked.

const CHARACTER = '11111111-1111-4111-8111-111111111111';
const queryMock = vi.fn();
const unmarked = vi.fn();
const catalogueTables: any[] = [];

vi.mock('$lib/server/db', () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock('$lib/server/services/forage', () => ({
  getUnmarkedSelfFind: (...args: unknown[]) => unmarked(...args),
  loadForageCatalogue: async () => ({ tables: catalogueTables }),
  getActiveTable: async () => null
}));

const route = await import('../../routes/vtt/api/forage/mine/+server');
const get = (userId: string) =>
  route.GET({ locals: { user: { id: userId } }, url: new URL(`http://localhost/x?characterId=${CHARACTER}`) } as any);

beforeEach(() => {
  vi.clearAllMocks();
  sessions.clear();
  catalogueTables.length = 0;
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

describe('GET /vtt/api/forage/mine availability (find tables belong to campaigns)', () => {
  const owner = (campaignId: string | null) =>
    queryMock.mockResolvedValue({ rows: [{ name: 'Thorne', active_vtt_session_id: null, campaign_id: campaignId }], rowCount: 1 });

  it('says no_campaign for a character with no campaign', async () => {
    owner(null);
    const body = await (await get('u1')).json();
    expect(body).toMatchObject({ available: false, unavailableReason: 'no_campaign' });
  });

  it('says no_tables for a campaign with nothing to forage, and wrong_room in a Quick room', async () => {
    owner('camp1');
    expect(await (await get('u1')).json()).toMatchObject({ available: false, unavailableReason: 'no_tables' });
    owner('camp1');
    queryMock.mockResolvedValue({ rows: [{ name: 'Thorne', active_vtt_session_id: 'Q1', campaign_id: 'camp1' }], rowCount: 1 });
    sessions.set('Q1', createSession('Q1')); // a Quick room: no campaignId
    expect(await (await get('u1')).json()).toMatchObject({ available: false, unavailableReason: 'wrong_room' });
  });

  it('is available in the campaign\'s own room when it has a pickable table', async () => {
    catalogueTables.push({ id: 't', campaignId: 'camp1', isArchived: false, pickableCount: 2, areaType: 'a', category: 'b' });
    queryMock.mockResolvedValue({ rows: [{ name: 'Thorne', active_vtt_session_id: 'C1', campaign_id: 'camp1' }], rowCount: 1 });
    sessions.set('C1', createSession('C1', { campaignId: 'camp1' }));
    const body = await (await get('u1')).json();
    expect(body).toMatchObject({ available: true, unavailableReason: null, inRoom: true });
    // Nothing about the tables themselves is in the response.
    expect(JSON.stringify(body)).not.toMatch(/"t"|areaType|pickableCount/);
  });
});
