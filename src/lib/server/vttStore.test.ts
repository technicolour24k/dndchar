import { beforeEach, describe, expect, it, vi } from 'vitest';
// Relative import, not the $vtt alias - store.js lives outside src/ entirely
// (see vtt/README.md) and this test only needs the plain module, not
// SvelteKit's alias resolution.
import { broadcast, createSession, dmPresent, filterSessionForRole, forageViewForPlayer, hasLiveGm, publish, removeWatcher, sessions, setWatches, socketsBySession, watchersByTopic } from '../../../vtt/server/store.js';

// A minimal stand-in for a real `ws` WebSocket - just enough for store.js's
// own OPEN/readyState/send checks (see store.js's broadcast/publish).
function fakeSocket() {
  return { readyState: 1, OPEN: 1, send: vi.fn() };
}

function fakeMeta(overrides: Partial<{ role: string | null; playerId: string | null }> = {}) {
  return { ws: fakeSocket(), sessionId: null, role: overrides.role ?? 'player', playerId: overrides.playerId ?? 'player-1', playerName: null, watchTopics: new Set<string>() };
}

// store.js's state lives on globalThis (see its own GLOBAL_KEY comment), so
// every test starts from a clean slate rather than leaking sessions/sockets/
// watchers between tests in this file.
beforeEach(() => {
  sessions.clear();
  socketsBySession.clear();
  watchersByTopic.clear();
});

describe('vtt store watch/publish (db-traffic-reduction Phase 5)', () => {
  it('setWatches registers a meta under each requested topic, and publish reaches it', () => {
    const watcher = fakeMeta();
    setWatches(watcher, ['room:ABC123']);

    publish('room:ABC123', { type: 'combat:log', message: 'hit' });

    expect(watcher.ws.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(watcher.ws.send.mock.calls[0][0]);
    expect(sent).toEqual({ type: 'combat:log', message: 'hit', topic: 'room:ABC123' });
  });

  it('publish does nothing when nobody is watching that topic', () => {
    expect(() => publish('room:NOBODY', { type: 'combat:log' })).not.toThrow();
  });

  it('removeWatcher (setWatches cleanup) stops further delivery', () => {
    const watcher = fakeMeta();
    setWatches(watcher, ['room:ABC123']);
    removeWatcher(watcher);

    publish('room:ABC123', { type: 'combat:log', message: 'hit' });

    expect(watcher.ws.send).not.toHaveBeenCalled();
    expect(watchersByTopic.has('room:ABC123')).toBe(false); // empty topic sets are pruned
  });

  it('a second setWatches call replaces the first topic list rather than adding to it', () => {
    const watcher = fakeMeta();
    setWatches(watcher, ['room:AAA']);
    setWatches(watcher, ['room:BBB']);

    publish('room:AAA', { type: 'combat:log' });
    publish('room:BBB', { type: 'combat:log' });

    expect(watcher.ws.send).toHaveBeenCalledTimes(1);
  });

  describe('broadcast() forwarding to room:<sessionId> watchers', () => {
    function setUp() {
      const sessionId = 'ROOM01';
      sessions.set(sessionId, { id: sessionId, tokens: {}, players: {}, markers: {}, map: null, gmSocketId: null, encounterId: null, gameSessionId: null });
      const playerMeta = fakeMeta({ role: 'player' });
      const gmMeta = fakeMeta({ role: 'gm' });
      socketsBySession.set(sessionId, new Set([playerMeta, gmMeta]));
      const watcher = fakeMeta();
      setWatches(watcher, [`room:${sessionId}`]);
      return { sessionId, playerMeta, gmMeta, watcher };
    }

    it('forwards an allow-listed type (combat:log) to watchers', () => {
      const { sessionId, watcher } = setUp();
      broadcast(sessionId, () => ({ type: 'combat:log', message: 'Orc attacks!', entry: { id: 'e1' } }));

      expect(watcher.ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(watcher.ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('combat:log');
      expect(sent.topic).toBe(`room:${sessionId}`);
    });

    it('forwards combat:state, roll:log and game_session:state too', () => {
      const { sessionId, watcher } = setUp();
      broadcast(sessionId, () => ({ type: 'combat:state', active: true, encounterId: 'enc-1' }));
      broadcast(sessionId, () => ({ type: 'roll:log', message: 'rolled a 20', entry: { id: 'r1' } }));
      broadcast(sessionId, () => ({ type: 'game_session:state', active: true, gameSessionId: 'gs-1' }));

      expect(watcher.ws.send).toHaveBeenCalledTimes(3);
    });

    it('does NOT forward an un-allow-listed type (token:move)', () => {
      const { sessionId, watcher } = setUp();
      broadcast(sessionId, () => ({ type: 'token:move', tokenId: 't1', x: 1, y: 1 }));

      expect(watcher.ws.send).not.toHaveBeenCalled();
    });

    it('still reaches real session sockets exactly as before, regardless of watchers', () => {
      const { sessionId, playerMeta, gmMeta } = setUp();
      broadcast(sessionId, () => ({ type: 'combat:log', message: 'hit' }));

      expect(playerMeta.ws.send).toHaveBeenCalledTimes(1);
      expect(gmMeta.ws.send).toHaveBeenCalledTimes(1);
    });

    it('a GM-only roll:log (recipient-gated payload) never reaches a watcher', () => {
      const { sessionId, watcher } = setUp();
      // Mirrors rollLog.ts's logRoll visibility:'gm' branch: buildPayload
      // returns null for anyone whose role isn't 'gm' - the synthetic watcher
      // recipient has role:'watcher', so it must be filtered out exactly like
      // a real player socket would be.
      broadcast(sessionId, (recipient: { role: string | null }) => (recipient.role === 'gm' ? { type: 'roll:log', message: 'secret gm roll' } : null));

      expect(watcher.ws.send).not.toHaveBeenCalled();
    });

    it('cleanup: after removeWatcher, further broadcasts on the same session are not forwarded', () => {
      const { sessionId, watcher } = setUp();
      removeWatcher(watcher);
      broadcast(sessionId, () => ({ type: 'combat:log', message: 'hit' }));

      expect(watcher.ws.send).not.toHaveBeenCalled();
    });
  });
});

describe('forage fields on the room (vtt-forage unit B)', () => {
  const request = {
    id: 'req-1', playerId: 'u1', stage: 'preview', source: 'vtt',
    choice: { skillKey: 'nature', tableId: 't1' }, check: { total: 17 },
    preview: { lines: [{ name: 'Moonleaf', qty: 3 }], tableEntries: [{ name: 'Secret' }] }
  };
  const result = { requestId: 'old', outcome: 'approved' };

  function roomWithForage(map: unknown = null) {
    const session: any = createSession('ROOM1');
    session.map = map;
    session.forage = { u1: request, u2: { ...request, id: 'req-2', playerId: 'u2' } };
    session.forageResults = { u1: result, u2: { requestId: 'other' } };
    return session;
  }

  it('createSession starts with empty forage and forageResults', () => {
    const session: any = createSession('ROOM1');
    expect(session.forage).toEqual({});
    expect(session.forageResults).toEqual({});
  });

  it('the GM sees everything', () => {
    const session = roomWithForage();
    const view: any = filterSessionForRole(session, 'gm', null);
    expect(view.forage.u1.preview).toBeDefined();
    expect(Object.keys(view.forage)).toEqual(['u1', 'u2']);
  });

  it('the finder sees only their own player view and result', () => {
    const view: any = filterSessionForRole(roomWithForage(), 'player', 'u1');
    expect(view.forage).toEqual({ u1: forageViewForPlayer(request) });
    expect(view.forage.u1).not.toHaveProperty('preview');
    expect(view.forage.u1).not.toHaveProperty('choice');
    expect(view.forageResults).toEqual({ u1: result });
  });

  it('another player sees empty objects for both', () => {
    const view: any = filterSessionForRole(roomWithForage(), 'player', 'u3');
    expect(view.forage).toEqual({});
    expect(view.forageResults).toEqual({});
  });

  it('the hidden-map branch strips them too', () => {
    const view: any = filterSessionForRole(roomWithForage({ revealed: false }), 'player', 'u3');
    expect(view.forage).toEqual({});
    expect(view.forageResults).toEqual({});
    const own: any = filterSessionForRole(roomWithForage({ revealed: false }), 'player', 'u1');
    expect(own.forage.u1).not.toHaveProperty('preview');
  });

  it('copes with a room made before the deploy (no forage fields)', () => {
    const session: any = createSession('ROOM1');
    delete session.forage;
    delete session.forageResults;
    const view: any = filterSessionForRole(session, 'player', 'u1');
    expect(view.forage).toEqual({});
  });

  describe('dmPresent', () => {
    function roomWithGm(gmSocketId: string | null, gmLive: boolean) {
      const session: any = createSession('ROOM2');
      session.gmSocketId = gmSocketId;
      sessions.set('ROOM2', session);
      const gm = { ...fakeMeta({ role: 'gm', playerId: null }), sessionId: 'ROOM2' };
      gm.ws.readyState = gmLive ? 1 : 3;
      socketsBySession.set('ROOM2', new Set([gm]));
      return session;
    }

    it('is false with no GM socket', () => {
      const session: any = createSession('ROOM2');
      session.gmSocketId = 'user-1';
      expect(hasLiveGm('ROOM2')).toBe(false);
      expect(dmPresent(session)).toBe(false);
    });

    it('is false when the GM socket has closed', () => {
      expect(dmPresent(roomWithGm('user-1', false))).toBe(false);
    });

    it('is false for the placeholder GM', () => {
      expect(dmPresent(roomWithGm('gm', true))).toBe(false);
    });

    it('is true for a live account GM', () => {
      expect(dmPresent(roomWithGm('user-1', true))).toBe(true);
    });
  });
});
