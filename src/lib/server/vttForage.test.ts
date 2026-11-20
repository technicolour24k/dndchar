import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, sessions, socketsBySession, watchersByTopic, setWatches } from '../../../vtt/server/store.js';
import {
  broadcastForageClosed, broadcastForageUpdate, canWithdraw, closeRequest, findPendingForUser, forageClosedFor, forageMessageFor,
  getRequest, isRoomGm, newRequest, resolveForageRoom, rollLogMessage, type ForageRequest
} from './vttForage';
import type { ForageCheck } from '$lib/types/forage';

function socket(open = true) {
  return { readyState: open ? 1 : 3, OPEN: 1, send: vi.fn() };
}
function meta(role: string, playerId: string | null, open = true) {
  // A real GM socket records the id it joined with as gmUserId (join.js).
  return { ws: socket(open), role, playerId, sessionId: 'ROOM', watchTopics: new Set<string>(), gmUserId: role === 'gm' ? 'gm-user' : undefined };
}

const check: ForageCheck = {
  skillKey: 'nature', skillLabel: 'Nature', total: 17, natural: 14, nat20: false, nat1: false, text: 'd20 14 + 3 = 17', poolSummary: ''
};

function request(overrides: Partial<ForageRequest> = {}): ForageRequest {
  return {
    ...newRequest({
      playerId: 'u1', playerName: 'Alice', characterId: 'c1', characterName: 'Thorne', tokenId: null, source: 'vtt',
      choice: { skillKey: 'nature', areaType: 'meadow', category: 'plant', tableId: 't1', advantage: { disabled: [], situationalAdvantage: 0, situationalDisadvantage: 0 } }
    }),
    ...overrides
  };
}

beforeEach(() => {
  sessions.clear();
  socketsBySession.clear();
  watchersByTopic.clear();
});

function room(gmSocketId: string | null = 'gm-user', gmLive = true) {
  const session: any = createSession('ROOM');
  session.gmSocketId = gmSocketId;
  sessions.set('ROOM', session);
  const gm = meta('gm', null, gmLive);
  socketsBySession.set('ROOM', new Set([gm]));
  return { session, gm };
}

describe('guards', () => {
  it('isRoomGm needs a matching user id and a live GM socket that joined with it', () => {
    const { session, gm } = room();
    expect(isRoomGm(session, 'gm-user')).toBe(true);
    expect(isRoomGm(session, 'someone')).toBe(false);
    expect(isRoomGm(session, '')).toBe(false);
    expect(isRoomGm({ id: 'ROOM', gmSocketId: null }, null)).toBe(false);
    gm.ws.readyState = 3; // the GM has gone
    expect(isRoomGm(session, 'gm-user')).toBe(false);
    gm.ws.readyState = 1;
    gm.gmUserId = 'someone-else';
    expect(isRoomGm(session, 'gm-user')).toBe(false);
  });

  it('findPendingForUser scans every room, and getRequest matches by id', () => {
    const { session } = room();
    const req = request();
    session.forage = { u1: req };
    expect(findPendingForUser('u1')?.request).toBe(req);
    expect(findPendingForUser('u2')).toBeNull();
    expect(getRequest(session, req.id)).toBe(req);
    expect(getRequest(session, 'nope')).toBeNull();
    expect(getRequest(session, 42)).toBeNull();
  });

  it('canWithdraw: requested always; later stages only with no live GM; never while approving', () => {
    const live = room().session;
    expect(canWithdraw(live, request({ stage: 'requested' }))).toBe(true);
    expect(canWithdraw(live, request({ stage: 'checked' }))).toBe(false);
    expect(canWithdraw(live, request({ stage: 'preview' }))).toBe(false);

    sessions.clear(); socketsBySession.clear();
    const gone = room('gm-user', false).session;
    expect(canWithdraw(gone, request({ stage: 'checked' }))).toBe(true);
    expect(canWithdraw(gone, request({ stage: 'preview' }))).toBe(true);
    expect(canWithdraw(gone, request({ stage: 'approving' }))).toBe(false);

    // A live placeholder GM (no account) is not a DM, so it doesn't strand the request.
    sessions.clear(); socketsBySession.clear();
    const placeholder = room('gm', true).session;
    expect(canWithdraw(placeholder, request({ stage: 'checked' }))).toBe(true);
  });
});

describe('resolveForageRoom', () => {
  it('sheet start with no active room gives no session', () => {
    expect(resolveForageRoom({ userId: 'u1', characterId: 'c1', activeRoomId: null })).toEqual({ session: null, token: null });
    expect(resolveForageRoom({ userId: 'u1', characterId: 'c1', activeRoomId: 'GONE' })).toEqual({ session: null, token: null });
  });

  it('sheet start in a live room with no token gives the session and a null token', () => {
    const { session } = room();
    const result = resolveForageRoom({ userId: 'u1', characterId: 'c1', activeRoomId: 'ROOM' });
    expect(result.session).toBe(session);
    expect(result.token).toBeNull();
  });

  it('sheet start finds the user\'s own token for the character', () => {
    const { session } = room();
    session.tokens = { a: { id: 'a', ownerId: 'u1', characterId: 'c1' }, b: { id: 'b', ownerId: 'u2', characterId: 'c1' } };
    expect(resolveForageRoom({ userId: 'u1', characterId: 'c1', activeRoomId: 'ROOM' }).token?.id).toBe('a');
  });

  it('VTT start refuses someone else\'s token, and a user who is not in the room', () => {
    const { session } = room();
    session.players = { u1: { id: 'u1' } };
    session.tokens = { b: { id: 'b', ownerId: 'u2', characterId: 'c1' } };
    expect(resolveForageRoom({ userId: 'u1', roomId: 'ROOM', characterId: 'c1', tokenId: 'b' }).error).toBe('bad_token');
    expect(resolveForageRoom({ userId: 'stranger', roomId: 'ROOM', characterId: 'c1' }).error).toBe('not_in_room');
  });

  it('VTT start accepts the user\'s own linked token, and rejects one linked to another character', () => {
    const { session } = room();
    session.players = { u1: { id: 'u1' } };
    session.tokens = { a: { id: 'a', ownerId: 'u1', characterId: 'c1' } };
    expect(resolveForageRoom({ userId: 'u1', roomId: 'ROOM', characterId: 'c1', tokenId: 'a' }).token?.id).toBe('a');
    expect(resolveForageRoom({ userId: 'u1', roomId: 'ROOM', characterId: 'c2', tokenId: 'a' }).error).toBe('bad_token');
  });

  it('VTT start in a room that has gone counts as no room', () => {
    expect(resolveForageRoom({ userId: 'u1', roomId: 'GONE', characterId: 'c1' })).toEqual({ session: null, token: null });
  });

  it('a bogus roomId falls back to the owner active room, so it cannot dodge a present DM', () => {
    const { session } = room();
    const result = resolveForageRoom({ userId: 'u1', roomId: 'JUNK', characterId: 'c1', activeRoomId: 'ROOM' });
    expect(result.session).toBe(session);
    expect(resolveForageRoom({ userId: 'u1', roomId: 'JUNK', characterId: 'c1', activeRoomId: 'ALSOGONE' }).session).toBeNull();
  });
});

describe('messages', () => {
  const full = request({ stage: 'preview', check, suggestedCheck: 'Nature DC 12', preview: { tableId: 't1', tableName: 'Meadow', nat20: false, runs: 1, lines: [{ itemId: 'i', name: 'Moonleaf', qty: 2 }], tableEntries: [] } });

  it('forageMessageFor: GM full, finder player view, others and watchers null', () => {
    expect((forageMessageFor({ role: 'gm', playerId: null }, full) as any).request.preview).toBeDefined();
    const mine = forageMessageFor({ role: 'player', playerId: 'u1' }, full) as any;
    expect(mine.request).toEqual({ id: full.id, stage: 'preview', source: 'vtt', check });
    expect(JSON.stringify(mine)).not.toContain('Nature DC');
    expect(forageMessageFor({ role: 'player', playerId: 'u2' }, full)).toBeNull();
    expect(forageMessageFor({ role: 'watcher', playerId: null }, full)).toBeNull();
    expect(forageMessageFor({ role: 'player', playerId: null }, full)).toBeNull();
  });

  it('forageClosedFor: GM and finder only', () => {
    expect(forageClosedFor({ role: 'gm', playerId: null }, full, 'cancelled', null)).toMatchObject({ type: 'forage:closed', outcome: 'cancelled' });
    expect(forageClosedFor({ role: 'player', playerId: 'u1' }, full, 'cancelled', null)).not.toBeNull();
    expect(forageClosedFor({ role: 'player', playerId: 'u2' }, full, 'cancelled', null)).toBeNull();
    expect(forageClosedFor({ role: 'watcher', playerId: null }, full, 'cancelled', null)).toBeNull();
  });

  it('broadcast reaches only the GM and finder, and a room watcher gets only a detail-free ping', () => {
    const { session, gm } = room();
    const finder = meta('player', 'u1');
    const other = meta('player', 'u2');
    const watcher = { ws: socket(), role: null, playerId: null, watchTopics: new Set<string>() };
    socketsBySession.get('ROOM')!.add(finder);
    socketsBySession.get('ROOM')!.add(other);
    setWatches(watcher, ['room:ROOM']);

    broadcastForageUpdate(session, full);

    expect(gm.ws.send).toHaveBeenCalledTimes(1);
    expect(finder.ws.send).toHaveBeenCalledTimes(1);
    expect(other.ws.send).not.toHaveBeenCalled();
    const sentToFinder = JSON.parse(finder.ws.send.mock.calls[0][0]);
    expect(JSON.stringify(sentToFinder)).not.toContain('Moonleaf');

    // The watcher got exactly one frame: the ping, carrying only the user id.
    expect(watcher.ws.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(watcher.ws.send.mock.calls[0][0])).toEqual({ type: 'forage:ping', playerId: 'u1', topic: 'room:ROOM' });

    broadcastForageClosed(session, full, 'cancelled', null);
    expect(other.ws.send).not.toHaveBeenCalled();
    for (const call of watcher.ws.send.mock.calls) expect(JSON.parse(call[0]).type).toBe('forage:ping');
  });

  it('closeRequest removes the request and records the finder\'s result', () => {
    const { session } = room();
    const req = request();
    session.forage = { u1: req };
    const result = closeRequest(session, req, 'failed');
    expect(session.forage).toEqual({});
    expect(session.forageResults.u1).toBe(result);
    expect(result).toMatchObject({ requestId: req.id, outcome: 'failed', characterId: 'c1' });

    const other = request();
    session.forage = { u1: other };
    expect(closeRequest(session, other, 'cancelled', {}, false)).toBeNull();
    expect(session.forage).toEqual({});
  });
});

describe('rollLogMessage', () => {
  const base = { characterName: 'Thorne', mode: 'dm' as const };
  it('formats a DM fail and pass', () => {
    expect(rollLogMessage({ ...base, check: { ...check, total: 9 }, outcome: 'failed', itemCount: 0 }))
      .toBe('Thorne foraged (Nature 9, fail) and found nothing of note.');
    expect(rollLogMessage({ ...base, check, outcome: 'found', itemCount: 5 }))
      .toBe('Thorne foraged (Nature 17, pass) and found 5 items.');
  });
  it('adds self-served, uses the singular, and shows natural 20 and 1', () => {
    expect(rollLogMessage({ ...base, mode: 'self', check, outcome: 'found', itemCount: 1 }))
      .toBe('Thorne foraged (Nature 17, pass, self-served) and found 1 item.');
    expect(rollLogMessage({ ...base, check: { ...check, nat20: true, natural: 20 }, outcome: 'found', itemCount: 3 }))
      .toContain('(Nature natural 20, pass)');
    expect(rollLogMessage({ ...base, check: { ...check, nat1: true, natural: 1 }, outcome: 'failed', itemCount: 0 }))
      .toContain('(Nature natural 1, fail)');
  });
});
