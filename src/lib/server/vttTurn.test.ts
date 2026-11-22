import { describe, expect, it, vi } from 'vitest';

vi.mock('$vtt/store.js', () => ({ sessions: new Map(), broadcast: vi.fn() }));

import { resetLiveTokenMovement } from './vttTurn';

// A room with a PC token of the character (30 ft speed, 10 left), a hidden one, another
// character's token and a token with no movement tracking.
function room(extra: Record<string, unknown> = {}): any {
  return {
    id: 'r1', map: { revealed: true },
    tokens: {
      a: { id: 'a', characterId: 'c1', speedFt: 30, speedRemainingFt: 10 },
      b: { id: 'b', characterId: 'c1', speedFt: 25, speedRemainingFt: 0, hidden: true },
      c: { id: 'c', characterId: 'c2', speedFt: 30, speedRemainingFt: 5 },
      d: { id: 'd', characterId: 'c1', speedFt: 30 }
    },
    ...extra
  };
}
function run(session: any, characterId = 'c1') {
  const sent: Record<string, unknown[]> = { gm: [], player: [] };
  const broadcast = (_id: string, build: (recipient: any) => unknown) => {
    for (const role of ['gm', 'player']) { const payload = build({ role }); if (payload) sent[role].push(payload); }
  };
  const count = resetLiveTokenMovement(characterId, { sessions: new Map([[session.id, session]]), broadcast });
  return { count, sent };
}

describe('resetLiveTokenMovement', () => {
  it('restores speed on the character tokens that track movement, and nobody else', () => {
    const session = room();
    const { count } = run(session);
    expect(count).toBe(2);
    expect(session.tokens.a.speedRemainingFt).toBe(30);
    expect(session.tokens.b.speedRemainingFt).toBe(25);
    expect(session.tokens.c.speedRemainingFt).toBe(5);
    expect(session.tokens.d.speedRemainingFt).toBeUndefined();
  });
  it('tells the GM everything and a player only the visible tokens', () => {
    const { sent } = run(room());
    expect(sent.gm).toEqual([{ type: 'token:move:resetAll', updates: [{ tokenId: 'a', speedRemainingFt: 30 }, { tokenId: 'b', speedRemainingFt: 25 }] }]);
    expect(sent.player).toEqual([{ type: 'token:move:resetAll', updates: [{ tokenId: 'a', speedRemainingFt: 30 }] }]);
  });
  it('tells a player nothing while the map is unrevealed', () => {
    const { sent } = run(room({ map: { revealed: false } }));
    expect(sent.player).toEqual([]);
    expect(sent.gm).toHaveLength(1);
  });
  it('does nothing without live tokens of that character, and a speedFt of 0 resets to 0', () => {
    expect(run(room(), 'nobody')).toEqual({ count: 0, sent: { gm: [], player: [] } });
    const session = room({ tokens: { z: { id: 'z', characterId: 'c1', speedRemainingFt: 7 } } });
    run(session);
    expect(session.tokens.z.speedRemainingFt).toBe(0);
  });
});
