import { beforeEach, describe, expect, it, vi } from 'vitest';

// The waiting flow behind the next-round routes: request, Ready / Hold on, Start now, Cancel, and a
// disconnect. Database, services and the live store are mocked; the pure state module is real.

const advance = vi.fn();
const sent: Array<{ who: string; payload: any }> = [];
let gmOfRoom = true;
const live = new Map<string, any>();
const socketsBySession = new Map<string, Set<any>>();
const hooks = new Map<string, (meta: any, session: any) => void>();

const sock = (playerId: string | null, role = 'player') => ({ role, playerId, ws: { OPEN: 1, readyState: 1 } });
let sockets: Set<any>;

vi.mock('$vtt/store.js', () => ({
  get sessions() { return live; },
  get socketsBySession() { return socketsBySession; },
  registerReleaseHook: (name: string, fn: any) => hooks.set(name, fn),
  // Every socket, then a watcher, the way the real broadcast builds recipients.
  broadcast: (id: string, build: (recipient: any) => unknown) => {
    for (const meta of socketsBySession.get(id) ?? []) {
      const payload = build(meta);
      if (payload) sent.push({ who: meta.role === 'gm' ? 'gm' : meta.playerId, payload });
    }
    const watcherPayload = build({ role: 'watcher', playerId: null });
    if (watcherPayload) sent.push({ who: 'watcher', payload: watcherPayload });
  }
}));
vi.mock('$lib/server/db', () => ({ query: vi.fn() }));
vi.mock('$lib/server/realtime', () => ({ emitRealtimeEvent: vi.fn() }));
vi.mock('$lib/server/vttForage', () => ({ isRoomGm: () => gmOfRoom }));
vi.mock('$lib/server/services/access', () => ({ getCharacterAccess: async () => ({ canEdit: true }) }));
vi.mock('$lib/server/services/catalogue', () => ({ advanceCharacterRound: (...args: unknown[]) => advance(...args) }));
vi.mock('$lib/server/services/turn-state', () => ({ getTurnView: async () => ({ profileKey: 'dnd5e', turnSeq: 1, pools: [], followups: [] }) }));

const gmRoute = await import('../../routes/vtt/api/session/[id]/next-round/+server');
const readyRoute = await import('../../routes/vtt/api/session/[id]/next-round/ready/+server');

const body = (data: unknown) => new Request('http://x', { method: 'POST', body: JSON.stringify(data) });
const gm = (action?: string) => gmRoute.POST({ locals: { user: { id: 'gm1' } }, params: { id: 'r1' }, request: body(action ? { action } : {}) } as any);
const player = (userId: string, action: string, pendingId: string | undefined = live.get('r1')?.roundPending?.id) =>
  readyRoute.POST({ locals: { user: { id: userId } }, params: { id: 'r1' }, request: body({ action, pendingId }) } as any);
const types = (who: string) => sent.filter((entry) => entry.who === who).map((entry) => entry.payload.type);
// Lets a fire-and-forget process (a disconnect completing the round) finish.
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

beforeEach(() => {
  advance.mockReset().mockResolvedValue(undefined);
  sent.length = 0;
  gmOfRoom = true;
  live.clear();
  socketsBySession.clear();
  sockets = new Set([sock('gm1', 'gm'), sock('p1'), sock('p2'), sock('p3')]);
  socketsBySession.set('r1', sockets);
  live.set('r1', {
    id: 'r1', campaignId: 'camp', map: { revealed: true },
    players: { p1: { name: 'Aria' }, p2: { name: 'Brom' }, p3: { name: 'Cass' } },
    tokens: {
      a: { id: 'a', ownerId: 'p1', characterId: 'c1', speedFt: 30, speedRemainingFt: 0 },
      b: { id: 'b', ownerId: 'p2', characterId: 'c2', speedFt: 30, speedRemainingFt: 0 }
    }
  });
});

describe('request', () => {
  it('opens a pending round and processes nothing yet', async () => {
    const res = await gm();
    expect(res.status).toBe(200);
    expect(advance).not.toHaveBeenCalled();
    expect(types('p1')).toEqual(['round:pending']);
    expect(types('p2')).toEqual(['round:pending']);
    expect(types('gm')).toEqual(['round:pending']);
    expect(types('p3')).toEqual([]); // connected but not on the map
    expect(types('watcher')).toEqual([]);
  });

  it('processes straight away when nobody is expected', async () => {
    live.get('r1').tokens = {};
    await gm();
    expect(advance).not.toHaveBeenCalled(); // no characters on the map, but the round itself still ran
    expect(types('gm')).toEqual(['round:done']);
    expect(types('p1')).toEqual(['round:next']);
  });

  it('answers already_pending to a second request, and only the room GM may ask', async () => {
    await gm();
    const again = await gm();
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('already_pending');
    gmOfRoom = false;
    expect((await gm()).status).toBe(403);
  });
});

describe('ready, hold and processing', () => {
  it('processes exactly once, when the last expected player is ready', async () => {
    await gm();
    await player('p1', 'ready');
    expect(advance).not.toHaveBeenCalled();
    await player('p2', 'ready');
    expect(advance.mock.calls.map((call) => call[1])).toEqual(['c1', 'c2']);
    expect(types('gm')).toContain('round:done');
    expect(types('p1')).toContain('round:next');
    expect(live.get('r1').roundPending).toBeNull();
  });

  it('hold tells the GM by name, and the player answer never carries the round result', async () => {
    await gm();
    const res = await player('p2', 'hold');
    expect(await res.json()).toEqual({ ok: true });
    const hold = sent.find((entry) => entry.payload.type === 'round:hold')!;
    expect(hold.who).toBe('gm');
    expect(hold.payload.name).toBe('Brom');
    await player('p1', 'ready');
    expect(advance).not.toHaveBeenCalled(); // Brom is holding, so the table waits
    await player('p2', 'ready');
    expect(advance).toHaveBeenCalledTimes(2);
  });

  it('players never see each other: updates carry only the player\'s own standing', async () => {
    await gm();
    sent.length = 0;
    await player('p1', 'hold');
    const forP2 = sent.filter((entry) => entry.who === 'p2');
    expect(forP2.map((entry) => entry.payload.view)).toEqual([{ id: expect.any(String), state: 'waiting' }]);
    expect(JSON.stringify(forP2)).not.toContain('Aria');
    expect(JSON.stringify(forP2)).not.toContain('holding');
  });

  it('start now and the last ready racing process only once', async () => {
    await gm();
    await player('p1', 'ready');
    await Promise.all([player('p2', 'ready'), gm('start')]);
    expect(advance).toHaveBeenCalledTimes(2); // c1 and c2 once each, not four calls
    expect(sent.filter((entry) => entry.payload.type === 'round:done')).toHaveLength(1);
  });

  it('start now processes whatever the state', async () => {
    await gm();
    expect((await gm('start')).status).toBe(200);
    expect(advance).toHaveBeenCalledTimes(2);
    expect((await gm('start')).status).toBe(409); // nothing left pending
  });

  it('a user who is not waited on is ignored, and a player cannot start or cancel', async () => {
    await gm();
    const res = await player('p3', 'ready');
    expect(res.status).toBe(409);
    expect((await player('stranger', 'ready')).status).toBe(409);
    gmOfRoom = false;
    expect((await gm('start')).status).toBe(403);
    expect((await gm('cancel')).status).toBe(403);
    expect(advance).not.toHaveBeenCalled();
    expect(live.get('r1').roundPending).not.toBeNull();
  });

  it('a Ready for an earlier round is refused', async () => {
    await gm();
    const res = await player('p1', 'ready', 'old-round-id');
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('stale_round');
    expect(live.get('r1').roundPending.members.p1.ready).toBe(false);
  });

  it('rejects an unknown action', async () => {
    await gm();
    expect((await player('p1', 'go')).status).toBe(400);
    expect((await gm('explode')).status).toBe(400);
  });
});

describe('cancel', () => {
  it('processes nothing and tells the GM and the waited-on players only', async () => {
    await gm();
    sent.length = 0;
    expect((await gm('cancel')).status).toBe(200);
    expect(advance).not.toHaveBeenCalled();
    expect(live.get('r1').roundPending).toBeNull();
    expect(types('gm')).toEqual(['round:cancelled']);
    expect(types('p1')).toEqual(['round:cancelled']);
    expect(types('p3')).toEqual([]);
    expect(types('watcher')).toEqual([]);
    expect((await player('p1', 'ready')).status).toBe(409); // nothing pending any more
  });
});

describe('disconnects', () => {
  const leave = (meta: any) => {
    sockets.delete(meta);
    hooks.get('nextRound')!(meta, live.get('r1'));
  };

  it('a player leaving can complete the set', async () => {
    const [, , p2] = [...sockets];
    await gm();
    await player('p1', 'ready');
    leave(p2);
    await settle();
    expect(advance).toHaveBeenCalledTimes(2); // both characters are still on the map
    expect(types('gm')).toContain('round:done');
  });

  it('keeps waiting while another tab of the same player is still open', async () => {
    const extra = sock('p2');
    sockets.add(extra);
    const [, , p2] = [...sockets];
    await gm();
    await player('p1', 'ready');
    leave(p2);
    await settle();
    expect(advance).not.toHaveBeenCalled();
    expect(live.get('r1').roundPending.members.p2).toBeDefined();
  });

  it('does not process when the only expected player drops (a reload), and lets them back in', async () => {
    live.get('r1').tokens = { a: { id: 'a', ownerId: 'p1', characterId: 'c1' } };
    sockets.delete([...sockets][2]); // p2 is not here
    await gm();
    const p1 = [...sockets][1];
    leave(p1);
    await settle();
    expect(advance).not.toHaveBeenCalled();
    expect(live.get('r1').roundPending).not.toBeNull();
  });
});
