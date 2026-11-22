import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /vtt/api/session/[id]/turn-reset: the GM's "Reset all" also gives every character on the map a fresh
// turn. Database, services and the live store are mocked: this checks who may call it and who it resets.

const reset = vi.fn();
const emit = vi.fn();
let gmOfRoom = true;
let editable = new Set<string>();
const live = new Map<string, any>();

vi.mock('$vtt/store.js', () => ({ get sessions() { return live; }, broadcast: vi.fn() }));
vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: async (fn: any) => fn({}) }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: (...args: unknown[]) => emit(...args) }));
vi.mock('$lib/server/vttForage', () => ({ isRoomGm: () => gmOfRoom }));
vi.mock('$lib/server/services/access', () => ({
  getCharacterAccess: async (_db: unknown, _user: string, characterId: string) => (editable.has(characterId) ? { canEdit: true, canAct: true } : { canEdit: false, canAct: false })
}));
vi.mock('$lib/server/services/turn-state', () => ({
  lockTurnState: async () => {},
  resetTurnState: (...args: unknown[]) => reset(...args),
  getTurnView: async (_db: unknown, id: string) => ({ profileKey: 'dnd5e', turnSeq: 2, pools: [{ key: 'action', label: 'Action', current: 1, max: 1 }], followups: [], id })
}));

const route = await import('../../routes/vtt/api/session/[id]/turn-reset/+server');
const post = () => route.POST({ locals: { user: { id: 'gm1' } }, params: { id: 'r1' } } as any);

beforeEach(() => {
  reset.mockReset();
  emit.mockReset();
  gmOfRoom = true;
  editable = new Set(['c1', 'c2']);
  live.clear();
  live.set('r1', { id: 'r1', tokens: { a: { characterId: 'c1' }, b: { characterId: 'c1' }, c: { characterId: 'c2' }, d: { characterId: 'c3' }, e: {}, f: { characterId: null } } });
});

describe('turn-reset route', () => {
  it('is 403 for anyone who is not the room GM, and resets nothing', async () => {
    gmOfRoom = false;
    expect((await post()).status).toBe(403);
    expect(reset).not.toHaveBeenCalled();
  });

  it('is 404 for a room that is not live', async () => {
    live.clear();
    expect((await post()).status).toBe(404);
  });

  it('resets each editable character once and skips the rest', async () => {
    const res = await post();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reset).toBe(2);
    expect(body.skipped).toBe(1); // c3 is not the caller's to reset
    expect(reset.mock.calls.map((call) => call[1]).sort()).toEqual(['c1', 'c2']);
    expect(reset.mock.calls[0][2]).toBe('Turn reset from the VTT');
    expect(emit).toHaveBeenCalledTimes(2);
    expect(Object.keys(body.views).sort()).toEqual(['c1', 'c2']);
    expect(body.views.c1).toEqual({ profileKey: 'dnd5e', turnSeq: 2, pools: [{ key: 'action', label: 'Action', current: 1, max: 1 }], followups: [] });
  });
});
