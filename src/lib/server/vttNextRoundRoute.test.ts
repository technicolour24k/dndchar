import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /vtt/api/session/[id]/next-round: the GM's table-wide round. Database, services and the live
// store are mocked: this checks who may call it, the order, who is skipped and who hears about it.

const advance = vi.fn();
const emit = vi.fn();
const sent: Array<{ role: string; payload: any }> = [];
let gmOfRoom = true;
let editable = new Set<string>();
const live = new Map<string, any>();

vi.mock('$vtt/store.js', () => ({
  get sessions() { return live; },
  broadcast: (_id: string, build: (recipient: any) => unknown) => {
    for (const role of ['gm', 'player']) { const payload = build({ role }); if (payload) sent.push({ role, payload }); }
  }
}));
vi.mock('$lib/server/db', () => ({ query: vi.fn() }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: (...args: unknown[]) => emit(...args) }));
vi.mock('$lib/server/vttForage', () => ({ isRoomGm: () => gmOfRoom }));
vi.mock('$lib/server/services/access', () => ({
  getCharacterAccess: async (_db: unknown, _user: string, id: string) => (editable.has(id) ? { canEdit: true } : { canEdit: false })
}));
vi.mock('$lib/server/services/catalogue', () => ({ advanceCharacterRound: (...args: unknown[]) => advance(...args) }));
vi.mock('$lib/server/services/turn-state', () => ({
  getTurnView: async () => ({ profileKey: 'dnd5e', turnSeq: 1, pools: [{ key: 'action', label: 'Action', current: 1, max: 1 }], followups: [] })
}));

const route = await import('../../routes/vtt/api/session/[id]/next-round/+server');
const post = () => route.POST({ locals: { user: { id: 'gm1' } }, params: { id: 'r1' } } as any);

beforeEach(() => {
  advance.mockReset().mockResolvedValue(undefined);
  emit.mockReset();
  sent.length = 0;
  gmOfRoom = true;
  editable = new Set(['c1', 'c2', 'c3']);
  live.clear();
  live.set('r1', {
    id: 'r1', map: { revealed: true },
    tokens: {
      a: { id: 'a', characterId: 'c3', speedFt: 30, speedRemainingFt: 0 },
      b: { id: 'b', characterId: 'c1', speedFt: 30, speedRemainingFt: 5 },
      c: { id: 'c', characterId: 'c1', speedFt: 30, speedRemainingFt: 5 },
      e: { id: 'e', speedFt: 40, speedRemainingFt: 0 }, // an enemy: no character, still gets its movement back
      h: { id: 'h', characterId: 'c2', hidden: true, speedFt: 20, speedRemainingFt: 0 }
    }
  });
});

describe('next-round route', () => {
  it('is 403 for anyone but the room GM and 404 for a room that is not live', async () => {
    gmOfRoom = false;
    expect((await post()).status).toBe(403);
    expect(advance).not.toHaveBeenCalled();
    gmOfRoom = true;
    live.clear();
    expect((await post()).status).toBe(404);
  });

  it('advances each distinct character once, in ascending id order, with turn effects ticking', async () => {
    const body = await (await post()).json();
    expect(advance.mock.calls.map((call) => call[1])).toEqual(['c1', 'c2', 'c3']);
    expect(advance.mock.calls[0][2]).toEqual({ tickTurnEffects: true });
    expect(body).toMatchObject({ advanced: 3, skipped: 0 });
    expect(emit.mock.calls.map((call) => call[0])).toEqual(['round:advanced', 'round:advanced', 'round:advanced']);
    expect(Object.keys(body.views)).toEqual(['c1', 'c2', 'c3']);
  });

  it('skips a character the GM cannot edit, and one that fails, and carries on', async () => {
    editable.delete('c1');
    advance.mockImplementation(async (_user: string, id: string) => { if (id === 'c2') throw new Error('boom'); });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const body = await (await post()).json();
    spy.mockRestore();
    expect(body).toMatchObject({ advanced: 1, skipped: 2 });
    expect(Object.keys(body.views)).toEqual(['c3']);
  });

  it('a second press within 2 seconds is a 409 too_soon and does nothing', async () => {
    expect((await post()).status).toBe(200);
    advance.mockClear();
    const again = await post();
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ error: 'too_soon' });
    expect(advance).not.toHaveBeenCalled();
  });

  it('resets movement on every token (enemies too), hiding hidden tokens from players', async () => {
    await post();
    const room = live.get('r1');
    expect(room.tokens.e.speedRemainingFt).toBe(40);
    expect(room.tokens.b.speedRemainingFt).toBe(30);
    const moves = sent.filter((entry) => entry.payload.type === 'token:move:resetAll');
    expect(moves.find((m) => m.role === 'gm')!.payload.updates).toHaveLength(5);
    expect(moves.find((m) => m.role === 'player')!.payload.updates.map((u: any) => u.tokenId)).not.toContain('h');
  });

  it('players get a detail-free round:next, the GM does not', async () => {
    await post();
    const nudges = sent.filter((entry) => entry.payload.type === 'round:next');
    expect(nudges.map((entry) => entry.role)).toEqual(['player']);
    expect(nudges[0].payload).toEqual({ type: 'round:next' });
  });
});
