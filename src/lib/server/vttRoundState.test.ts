import { describe, expect, it } from 'vitest';
import {
  dropMember, expectedUserIds, gmView, isComplete, openPending, playerView, rejoinMember, roundPendingFor, setHolding, setReady
} from '../../../vtt/server/roundState.js';

// The pure side of "Next round waits for Ready": who is expected, and the ready / hold transitions.

const socket = (playerId: string, open = true, role = 'player') => ({ role, playerId, ws: { OPEN: 1, readyState: open ? 1 : 3 } });
const room = (extra: Record<string, unknown> = {}) => ({
  id: 'r1', campaignId: 'camp', players: { p1: { name: 'Aria' }, p2: { name: 'Brom' }, p3: { name: 'Cass' } },
  tokens: { t1: { ownerId: 'p1', characterId: 'c1' }, t2: { ownerId: 'p2', characterId: 'c2' }, e: { type: 'enemy' } },
  ...extra
});

describe('expectedUserIds', () => {
  it('is the connected players who own a character token on the map', () => {
    const sockets = new Set([socket('p1'), socket('p2'), socket('p3'), socket('gm1', true, 'gm')]);
    expect(expectedUserIds(room(), sockets).sort()).toEqual(['p1', 'p2']); // p3 has no token, the GM never counts
  });

  it('leaves out a closed socket and a token with no character, and counts a second tab once', () => {
    const sockets = new Set([socket('p1'), socket('p1'), socket('p2', false)]);
    expect(expectedUserIds(room(), sockets)).toEqual(['p1']);
    const noChar = room({ tokens: { t1: { ownerId: 'p1' } } });
    expect(expectedUserIds(noChar, new Set([socket('p1')]))).toEqual([]);
  });

  it('expects nobody in a Quick room (a player id there is only a claim)', () => {
    expect(expectedUserIds(room({ campaignId: null }), new Set([socket('p1')]))).toEqual([]);
  });
});

describe('ready and hold transitions', () => {
  it('is complete only when every member is ready, and an empty set is complete', () => {
    const session: any = room();
    const pending = openPending(session, ['p1', 'p2'], 'gm1');
    expect(isComplete(pending)).toBe(false);
    setReady(session, 'p1');
    expect(isComplete(pending)).toBe(false);
    setReady(session, 'p2');
    expect(isComplete(pending)).toBe(true);
    expect(isComplete(openPending(room(), [], 'gm1'))).toBe(true);
  });

  it('hold clears ready and ready clears hold', () => {
    const session: any = room();
    openPending(session, ['p1'], 'gm1');
    setReady(session, 'p1');
    setHolding(session, 'p1');
    expect(session.roundPending.members.p1).toMatchObject({ ready: false, holding: true });
    setReady(session, 'p1');
    expect(session.roundPending.members.p1).toMatchObject({ ready: true, holding: false });
  });

  it('ignores a user who is not a member, and does nothing with no pending round', () => {
    const session: any = room();
    expect(setReady(session, 'p1')).toBe(false);
    openPending(session, ['p1'], 'gm1');
    expect(setReady(session, 'p2')).toBe(false);
    expect(setHolding(session, 'p2')).toBe(false);
    expect(session.roundPending.members.p2).toBeUndefined();
  });

  it('a dropped member can complete the set, and a returning one is expected again only if on the map', () => {
    const session: any = room();
    openPending(session, ['p1', 'p2'], 'gm1');
    setReady(session, 'p1');
    expect(dropMember(session, 'p2')).toBe(true);
    expect(isComplete(session.roundPending)).toBe(true);
    expect(dropMember(session, 'p2')).toBe(false);
    expect(rejoinMember(session, 'p2')).toBe(true);
    expect(session.roundPending.members.p2.ready).toBe(false);
    expect(rejoinMember(session, 'p3')).toBe(false); // no token of theirs
    expect(rejoinMember(session, 'p1')).toBe(false); // already a member
  });
});

describe('views', () => {
  it('the GM sees everyone, a player only their own standing', () => {
    const session: any = room();
    openPending(session, ['p1', 'p2'], 'gm1');
    setReady(session, 'p1');
    setHolding(session, 'p2');
    const gm = gmView(session.roundPending);
    expect(gm.ready.map((p: any) => p.name)).toEqual(['Aria']);
    expect(gm.holding.map((p: any) => p.name)).toEqual(['Brom']);
    expect(playerView(session.roundPending, 'p1')).toEqual({ id: session.roundPending.id, state: 'ready' });
    expect(playerView(session.roundPending, 'p3')).toBeNull();
  });

  it('state:full carries a per-role view and nothing for anyone else', () => {
    const session: any = room();
    expect(roundPendingFor(session, 'player', 'p1')).toBeNull();
    openPending(session, ['p1', 'p2'], 'gm1');
    setHolding(session, 'p2');
    expect(roundPendingFor(session, 'gm', null)).toHaveProperty('holding');
    const mine = roundPendingFor(session, 'player', 'p1');
    expect(JSON.stringify(mine)).not.toContain('Brom');
    expect(JSON.stringify(mine)).not.toContain('p2');
    expect(roundPendingFor(session, 'watcher', null)).toBeNull();
    expect(roundPendingFor(session, 'player', 'p3')).toBeNull();
  });
});
