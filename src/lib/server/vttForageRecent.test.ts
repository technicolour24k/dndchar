import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /vtt/api/forage/recent: owner-checked, and the payload never carries a table name, id or
// suggested check (Rev 4). The database is mocked.

const CHARACTER = '11111111-1111-4111-8111-111111111111';
const queryMock = vi.fn();
const listRecent = vi.fn();

vi.mock('$lib/server/db', () => ({ query: (...args: unknown[]) => queryMock(...args) }));
vi.mock('$lib/server/services/forage', () => ({
  listRecentFindsForCharacter: (...args: unknown[]) => listRecent(...args),
  loadForageCatalogue: async () => ({ tables: [] }),
  getActiveTable: async () => null
}));

const route = await import('../../routes/vtt/api/forage/recent/+server');

const get = (userId: string, characterId: string | null) =>
  route.GET({
    locals: { user: { id: userId } },
    url: new URL(`http://localhost/vtt/api/forage/recent${characterId ? `?characterId=${characterId}` : ''}`)
  } as any);

const find = { id: 'f1', createdAt: '2026-11-20T10:00:00Z', status: 'found', mode: 'self', shared: false, items: [{ name: 'Moonleaf', qty: 3 }], revertNote: '' };

beforeEach(() => {
  vi.clearAllMocks();
  listRecent.mockResolvedValue([find]);
});

describe('GET /vtt/api/forage/recent', () => {
  it('is owner-checked: someone else\'s character, a missing id and a bad id are all 404', async () => {
    queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
    expect((await get('intruder', CHARACTER)).status).toBe(404);
    expect((await get('u1', null)).status).toBe(404);
    expect((await get('u1', 'not-a-uuid')).status).toBe(404);
    expect(listRecent).not.toHaveBeenCalled();
    // The ownership query is scoped to the caller, not just the character.
    expect(queryMock.mock.calls[0][1]).toEqual([CHARACTER, 'intruder']);
  });

  it('returns the owner\'s finds with no table fields', async () => {
    queryMock.mockResolvedValue({ rows: [{ name: 'Thorne', active_vtt_session_id: null }], rowCount: 1 });
    const res = await get('u1', CHARACTER);
    expect(res.status).toBe(200);
    expect(listRecent).toHaveBeenCalledWith(CHARACTER);
    const body = await res.json();
    expect(body.finds).toEqual([find]);
    expect(JSON.stringify(body)).not.toMatch(/table|suggested/i);
  });
});
