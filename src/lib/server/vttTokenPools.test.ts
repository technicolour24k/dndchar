import { describe, expect, it } from 'vitest';
// Relative imports: the VTT server code lives outside src/ (same as vttTokenMove.test.ts).
import handleTokenEvent, { sanitizePools } from '../../../vtt/server/handlers/token.js';

// token.pools is a client-written display copy, so the server rebuilds it and never stores msg.value raw.
const good = { key: 'vowfire', label: 'Vowfire', current: 1, max: 3, rechargePeriod: 'long_rest' };

type Meta = Record<string, any>;
const owner: Meta = { role: 'player', playerId: 'p1', sessionId: 's1' };
// A refused sender is told over its own socket, so every meta needs one.
const socket = () => ({ send: () => {} });
const other: Meta = { role: 'player', playerId: 'p2', sessionId: 's1', ws: socket() };
const gm: Meta = { role: 'gm', playerId: null, sessionId: 's1' };

function update(sender: Meta, value: unknown) {
  const session = { tokens: { t1: { id: 't1', type: 'pc', ownerId: 'p1', hidden: false, pools: [good] } as Record<string, any> } };
  const sent: any[] = [];
  const context = {
    sessions: new Map([['s1', session]]),
    broadcast: (_sid: string, build: (r: Meta) => unknown) => {
      for (const r of [gm, owner, other]) {
        const p = build(r);
        if (p) sent.push(p);
      }
    }
  };
  handleTokenEvent(sender, { type: 'token:stat:update', tokenId: 't1', stat: 'pools', value }, context);
  return { token: session.tokens.t1, sent };
}

describe('sanitizePools', () => {
  it('rebuilds a good list, clamping the numbers', () => {
    expect(sanitizePools([good])).toEqual([good]);
    expect(sanitizePools([{ ...good, current: -4, max: 5000 }])).toEqual([{ ...good, current: 0, max: 999 }]);
    expect(sanitizePools([])).toEqual([]);
  });

  it('drops extra fields and never returns the input objects', () => {
    const input = [{ ...good, evil: '<script>', __proto__: { x: 1 } }];
    const clean = sanitizePools(input)!;
    expect(clean[0]).not.toBe(input[0]);
    expect(Object.keys(clean[0]).sort()).toEqual(['current', 'key', 'label', 'max', 'rechargePeriod']);
  });

  it('rejects anything malformed', () => {
    const bad: unknown[] = [
      null, 'x', {}, [null], [1], [{ ...good, current: '<img src=x onerror=alert(1)>' }], [{ ...good, current: 1.5 }], [{ ...good, max: NaN }],
      [{ ...good, current: '1' }], [{ ...good, key: 5 }], [{ ...good, key: '' }], [{ ...good, key: 'k'.repeat(41) }], [{ ...good, label: 'l'.repeat(81) }],
      [{ key: 'a', label: 'b' }], Array.from({ length: 21 }, () => good)
    ];
    for (const value of bad) expect(sanitizePools(value as any)).toBeNull();
    expect(sanitizePools(Array.from({ length: 20 }, () => good))).toHaveLength(20);
  });
});

describe('token:stat:update on pools', () => {
  it('stores and broadcasts a rebuilt copy for the token owner and the GM', () => {
    const value = [{ ...good, current: 2, extra: 'x' }];
    const { token, sent } = update(owner, value);
    expect(token.pools).toEqual([{ ...good, current: 2 }]);
    expect(token.pools).not.toBe(value);
    expect(sent.length).toBeGreaterThan(0);
    expect(update(gm, [good]).token.pools).toEqual([good]);
  });

  it('ignores an HTML payload in current: nothing is stored or sent', () => {
    const { token, sent } = update(owner, [{ ...good, current: '<img src=x onerror=alert(1)>' }]);
    expect(token.pools).toEqual([good]); // unchanged
    expect(sent).toEqual([]);
  });

  it('ignores a non-owner, and an oversized or non-array value', () => {
    expect(update(other, [{ ...good, current: 0 }]).token.pools).toEqual([good]);
    expect(update(owner, 'x').token.pools).toEqual([good]);
    expect(update(owner, Array.from({ length: 21 }, () => good)).token.pools).toEqual([good]);
  });
});
