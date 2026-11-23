import { describe, expect, it, vi } from 'vitest';

vi.mock('$vtt/store.js', () => ({ sessions: new Map(), broadcast: vi.fn(), filterTokenForPlayer: (token: any) => ({ ...token, filtered: true }) }));

import { nudgeCharacterTokenHp } from './vttTokenHp';

function room(extra: Record<string, unknown> = {}): any {
  return {
    id: 'r1', map: { revealed: true },
    tokens: {
      a: { id: 'a', type: 'pc', characterId: 'c1', stats: { hp: 10, maxHp: 20 } },
      h: { id: 'h', type: 'pc', characterId: 'c1', hidden: true, stats: { hp: 5, maxHp: 20 } },
      e: { id: 'e', type: 'enemy', characterId: 'c1', stats: { hp: 10, maxHp: 20 } },
      o: { id: 'o', type: 'pc', characterId: 'c2', stats: { hp: 10, maxHp: 20 } }
    },
    ...extra
  };
}
function run(session: any, delta: number, characterId = 'c1') {
  const sent: Record<string, any[]> = { gm: [], player: [] };
  const broadcast = (_id: string, build: (recipient: any) => unknown) => {
    for (const role of ['gm', 'player']) { const payload = build({ role }); if (payload) sent[role].push(payload); }
  };
  const applied = nudgeCharacterTokenHp('r1', characterId, delta, { sessions: new Map([[session.id, session]]), broadcast });
  return { applied, sent };
}

describe('nudgeCharacterTokenHp', () => {
  it('clamps to 0..maxHp and returns the delta actually applied', () => {
    const up = room();
    expect(run(up, 50).applied).toEqual({ a: 10, h: 15 });
    expect(up.tokens.a.stats.hp).toBe(20);
    const down = room();
    expect(run(down, -50).applied).toEqual({ a: -10, h: -5 });
    expect(down.tokens.a.stats.hp).toBe(0);
  });
  it('skips enemy tokens and other characters', () => {
    const session = room();
    run(session, -3);
    expect(session.tokens.e.stats.hp).toBe(10);
    expect(session.tokens.o.stats.hp).toBe(10);
    expect(session.tokens.a.stats.hp).toBe(7);
  });
  it('tells the GM about a hidden token and players only about visible ones, in the token:stat:update shape', () => {
    const session = room();
    const { sent } = run(session, -3);
    expect(sent.gm.map((m) => m.tokenId).sort()).toEqual(['a', 'h']);
    expect(sent.player.map((m) => m.tokenId)).toEqual(['a']);
    expect(sent.gm[0]).toMatchObject({ type: 'token:stat:update', stat: 'hp' });
    expect(sent.player[0].token.filtered).toBe(true);
  });
  it('says nothing to players while the map is unrevealed, and does nothing for an unknown room or zero delta', () => {
    const session = room({ map: { revealed: false } });
    expect(run(session, -1).sent.player).toEqual([]);
    expect(nudgeCharacterTokenHp('nope', 'c1', -1, { sessions: new Map(), broadcast: vi.fn() })).toEqual({});
    expect(run(room(), 0).applied).toEqual({});
  });
  it('never pulls a token that is already over max down on a positive delta', () => {
    const session = room();
    session.tokens.a.stats.hp = 25;
    expect(run(session, 5).applied.a).toBeUndefined();
    expect(session.tokens.a.stats.hp).toBe(25);
    expect(session.tokens.h.stats.hp).toBe(10);
  });
  it('keeps a per-token delta map, and undo can target one token with its own amount', () => {
    const session = room();
    const { applied } = run(session, -8);
    expect(applied).toEqual({ a: -8, h: -5 });
    const undo = nudgeCharacterTokenHp('r1', 'c1', 5, { sessions: new Map([['r1', session]]), broadcast: vi.fn() }, 'h');
    expect(undo).toEqual({ h: 5 });
    expect(session.tokens.h.stats.hp).toBe(5);
    expect(session.tokens.a.stats.hp).toBe(2);
  });
});
