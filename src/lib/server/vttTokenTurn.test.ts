import { describe, expect, it } from 'vitest';
// Relative imports: the VTT server code lives outside src/ (same as vttTokenPools.test.ts).
import handleTokenEvent, { sanitizeTurn } from '../../../vtt/server/handlers/token.js';
import { trimTurnView } from '../../../static/vtt-app/shared/actionEconomy.js';

// token.turn is a client-written DISPLAY copy of a character's turn view, so the server rebuilds it and
// never stores msg.value raw.
const good = {
  profileKey: 'attack_utility', turnSeq: 4,
  pools: [{ key: 'attack', label: 'Attack', current: 1, max: 2 }, { key: 'utility', label: 'Utility', current: 2, max: 2 }],
  followups: [{ cls: 'melee', label: 'Extra Attack', remaining: 1 }]
};

type Meta = Record<string, any>;
const owner: Meta = { role: 'player', playerId: 'p1', sessionId: 's1' };
const socket = () => ({ send: () => {} });
const other: Meta = { role: 'player', playerId: 'p2', sessionId: 's1', ws: socket() };
const gm: Meta = { role: 'gm', playerId: null, sessionId: 's1' };

function run(sender: Meta, msg: Record<string, unknown>, token: Record<string, any> = { id: 't1', type: 'pc', ownerId: 'p1', hidden: false, turn: good }) {
  const session = { tokens: { t1: token } as Record<string, any> };
  const sent: any[] = [];
  const context = {
    sessions: new Map([['s1', session]]),
    broadcast: (_sid: string, build: (r: Meta) => unknown) => {
      for (const r of [gm, owner, other]) { const p = build(r); if (p) sent.push(p); }
    }
  };
  handleTokenEvent(sender, msg, context);
  return { session, sent };
}
const update = (sender: Meta, value: unknown) => run(sender, { type: 'token:stat:update', tokenId: 't1', stat: 'turn', value });

describe('sanitizeTurn', () => {
  it('rebuilds a good view, clamping the numbers', () => {
    expect(sanitizeTurn(good)).toEqual(good);
    const clamped = sanitizeTurn({ ...good, pools: [{ key: 'a', label: 'A', current: -3, max: 500 }], followups: [{ cls: 'melee', label: 'X', remaining: 400 }] })!;
    expect(clamped.pools).toEqual([{ key: 'a', label: 'A', current: 0, max: 99 }]);
    expect(clamped.followups).toEqual([{ cls: 'melee', label: 'X', remaining: 99 }]);
    expect(sanitizeTurn({ ...good, pools: [], followups: [] })).toEqual({ ...good, pools: [], followups: [] });
  });

  it('drops extra fields and never returns the input objects', () => {
    const input = { ...good, evil: '<script>', pools: [{ ...good.pools[0], evil: 1 }] };
    const clean = sanitizeTurn(input)!;
    expect(clean).not.toBe(input);
    expect(clean.pools[0]).not.toBe(input.pools[0]);
    expect(Object.keys(clean)).toEqual(['profileKey', 'turnSeq', 'pools', 'followups']);
    expect(Object.keys(clean.pools[0])).toEqual(['key', 'label', 'current', 'max']);
  });

  it('rejects anything malformed', () => {
    const pool = good.pools[0];
    const followup = good.followups[0];
    const bad: unknown[] = [
      null, 'x', [], {}, { ...good, profileKey: 5 }, { ...good, profileKey: '' }, { ...good, profileKey: 'k'.repeat(41) }, { ...good, turnSeq: '4' }, { ...good, turnSeq: 1.5 },
      { ...good, pools: 'x' }, { ...good, followups: null }, { ...good, pools: Array.from({ length: 7 }, () => pool) }, { ...good, followups: Array.from({ length: 5 }, () => followup) },
      { ...good, pools: [null] }, { ...good, pools: [{ ...pool, current: '<img src=x onerror=alert(1)>' }] }, { ...good, pools: [{ ...pool, max: 1.5 }] },
      { ...good, pools: [{ ...pool, key: '' }] }, { ...good, pools: [{ ...pool, label: 'l'.repeat(81) }] },
      { ...good, followups: [{ ...followup, remaining: '1' }] }, { ...good, followups: [{ ...followup, cls: 'c'.repeat(21) }] }, { ...good, followups: [1] }
    ];
    for (const value of bad) expect(sanitizeTurn(value as any), JSON.stringify(value)).toBeNull();
    expect(sanitizeTurn({ ...good, pools: Array.from({ length: 6 }, () => pool), followups: Array.from({ length: 4 }, () => followup) })).not.toBeNull();
  });

  it('agrees with the client trim, so a resync never resends an unchanged copy', () => {
    const full = { ...good, profileLabel: 'x', log: [{ label: 'a' }], pools: good.pools.map((p) => ({ ...p, spent: 0, breakdown: [] })), followups: [{ ...good.followups[0], perAction: 1 }] };
    expect(JSON.stringify(sanitizeTurn(trimTurnView(full)))).toBe(JSON.stringify(trimTurnView(full)));
  });
});

describe('token:stat:update on turn', () => {
  it('stores and broadcasts a rebuilt copy for the token owner and the GM', () => {
    const value = { ...good, turnSeq: 5, evil: 'x' };
    const { session, sent } = update(owner, value);
    expect(session.tokens.t1.turn).toEqual({ ...good, turnSeq: 5 });
    expect(session.tokens.t1.turn).not.toBe(value);
    expect(sent.length).toBeGreaterThan(0);
    expect(update(gm, { ...good, turnSeq: 9 }).session.tokens.t1.turn.turnSeq).toBe(9);
  });

  it('ignores an HTML payload and malformed values: nothing is stored or sent', () => {
    const attack = update(owner, { ...good, pools: [{ ...good.pools[0], current: '<img src=x onerror=alert(1)>' }] });
    expect(attack.session.tokens.t1.turn).toEqual(good);
    expect(attack.sent).toEqual([]);
    expect(update(owner, 'x').session.tokens.t1.turn).toEqual(good);
  });

  it('a player cannot write another token\'s turn', () => {
    const { session, sent } = update(other, { ...good, turnSeq: 99 });
    expect(session.tokens.t1.turn).toEqual(good);
    expect(sent).toEqual([]);
  });
});

describe('token:add', () => {
  const add = (sender: Meta, token: Record<string, any>) => {
    const { session } = run(sender, { type: 'token:add', token }, {} as any);
    return session.tokens[token.id];
  };
  it('rebuilds turn on an added token, and drops a malformed one', () => {
    expect(add(owner, { id: 'n1', type: 'pc', ownerId: 'p1', turn: { ...good, evil: 1 } }).turn).toEqual(good);
    expect('turn' in add(owner, { id: 'n2', type: 'pc', ownerId: 'p1', turn: { nope: true } })).toBe(false);
  });
});
