import { describe, expect, it, vi } from 'vitest';

vi.mock('$vtt/store.js', () => ({ sessions: new Map(), broadcast: vi.fn(), filterTokenForPlayer: (token: any) => ({ ...token, filtered: true }) }));

import { followSheetAc, primeSheetAc, primeTokenSheetAc, scheduleFollowSheetAc } from './vttTokenAc';

function room(): any {
  return {
    id: 'r1', map: { revealed: true },
    tokens: {
      a: { id: 'a', type: 'pc', characterId: 'c1', ac: 17, sheetAc: 15, knownAc: 16 },
      h: { id: 'h', type: 'pc', characterId: 'c1', hidden: true, ac: 15, sheetAc: 15 },
      e: { id: 'e', type: 'enemy', characterId: 'c1', ac: 12, sheetAc: 12 },
      o: { id: 'o', type: 'pc', characterId: 'c2', ac: 14, sheetAc: 14 }
    }
  };
}
function deps(session: any, loadAc: (id: string) => Promise<number | null>) {
  const sent: Record<string, any[]> = { gm: [], player: [] };
  const broadcast = (_id: string, build: (recipient: any) => unknown) => {
    for (const role of ['gm', 'player']) { const payload = build({ role }); if (payload) sent[role].push(payload); }
  };
  return { sent, deps: { sessions: new Map([[session.id, session]]), broadcast, loadAc } };
}

describe('followSheetAc', () => {
  it('moves the token by the sheet delta, keeping a manual offset (15 -> 18: 17 -> 20, back: 17)', async () => {
    const session = room();
    const loadAc = vi.fn().mockResolvedValueOnce(18).mockResolvedValueOnce(15);
    const { deps: d } = deps(session, loadAc);
    await followSheetAc(['c1'], d);
    expect(session.tokens.a.ac).toBe(20);
    expect(session.tokens.a.sheetAc).toBe(18);
    await followSheetAc(['c1'], d);
    expect(session.tokens.a.ac).toBe(17);
  });

  it('clears knownAc, leaves enemies and other characters alone, and tells a hidden token to the GM only', async () => {
    const session = room();
    const { deps: d, sent } = deps(session, async () => 18);
    await followSheetAc(['c1'], d);
    expect(session.tokens.a.knownAc).toBeNull();
    expect(session.tokens.e.ac).toBe(12);
    expect(session.tokens.o.ac).toBe(14);
    expect(session.tokens.h.ac).toBe(18);
    expect(sent.gm.filter((m) => m.tokenId === 'h' && m.stat === 'ac')).toHaveLength(1);
    expect(sent.player.filter((m) => m.tokenId === 'h')).toHaveLength(0);
    expect(sent.player.some((m) => m.tokenId === 'a' && m.stat === 'ac' && m.value === 20)).toBe(true);
    expect(sent.player.some((m) => m.tokenId === 'a' && m.stat === 'knownAc' && m.value === null)).toBe(true);
  });

  it('records a first baseline without moving the token', async () => {
    const session = room();
    delete session.tokens.a.sheetAc;
    const { deps: d } = deps(session, async () => 18);
    await followSheetAc(['c1'], d);
    expect(session.tokens.a.ac).toBe(17);
    expect(session.tokens.a.sheetAc).toBe(18);
  });

  it('primeSheetAc only fills a missing baseline (so the next follow still moves the token)', async () => {
    const session = room();
    delete session.tokens.a.sheetAc;
    const loadAc = vi.fn().mockResolvedValueOnce(15).mockResolvedValueOnce(12);
    const { deps: d } = deps(session, loadAc);
    await primeSheetAc(['c1'], d);
    expect(session.tokens.a.sheetAc).toBe(15);
    expect(session.tokens.a.ac).toBe(17);
    await followSheetAc(['c1'], d);
    expect(session.tokens.a.ac).toBe(14);
    await primeSheetAc(['c1'], d); // every token has a baseline now: no load
    expect(loadAc).toHaveBeenCalledTimes(2);
  });

  it('serialises overlapping follows per character, so a slow older load cannot land last', async () => {
    const session = room();
    const resolvers: Array<(ac: number) => void> = [];
    const loadAc = vi.fn(() => new Promise<number>((resolve) => { resolvers.push(resolve); }));
    const { deps: d } = deps(session, loadAc);
    const first = followSheetAc(['c1'], d);
    const second = followSheetAc(['c1'], d);
    await vi.waitFor(() => expect(loadAc).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadAc).toHaveBeenCalledTimes(1); // the second waits its turn
    resolvers[0](18);
    await first;
    await vi.waitFor(() => expect(loadAc).toHaveBeenCalledTimes(2));
    resolvers[1](16);
    await second;
    expect(session.tokens.a.sheetAc).toBe(16);
    expect(session.tokens.a.ac).toBe(18); // 17 + (16 - 15)
  });

  it('does no loading when no live PC token matches, and survives a load that returns nothing', async () => {
    const loadAc = vi.fn(async () => 18);
    const { deps: d } = deps(room(), loadAc);
    await followSheetAc(['nobody'], d);
    expect(loadAc).not.toHaveBeenCalled();
    const session = room();
    await followSheetAc(['c1'], deps(session, async () => null).deps);
    expect(session.tokens.a.ac).toBe(17);
  });

  it('clamps the token AC to 0..99', async () => {
    const session = room();
    await followSheetAc(['c1'], deps(session, async () => 100).deps);
    expect(session.tokens.a.ac).toBe(99);
    await followSheetAc(['c1'], deps(session, async () => 0).deps);
    expect(session.tokens.a.ac).toBe(0);
  });
});

describe('primeTokenSheetAc', () => {
  it('records the real sheet AC on one new token without moving its (GM-typed) AC, so a later change keeps the offset', async () => {
    const session = room();
    session.tokens.n = { id: 'n', type: 'pc', characterId: 'c1', ac: 15 }; // GM typed 15, the sheet says 17
    const loadAc = vi.fn().mockResolvedValueOnce(17).mockResolvedValueOnce(19);
    const { deps: d } = deps(session, loadAc);
    await primeTokenSheetAc('r1', 'n', d);
    expect(session.tokens.n.sheetAc).toBe(17);
    expect(session.tokens.n.ac).toBe(15);
    await followSheetAc(['c1'], d);
    expect(session.tokens.n.ac).toBe(17); // 15 + 2
    await primeTokenSheetAc('r1', 'n', d); // has a baseline: no load
    expect(loadAc).toHaveBeenCalledTimes(2);
  });
  it('ignores unknown tokens and enemies', async () => {
    const loadAc = vi.fn(async () => 17);
    const { deps: d } = deps(room(), loadAc);
    await primeTokenSheetAc('r1', 'nope', d);
    await primeTokenSheetAc('r1', 'e', d);
    expect(loadAc).not.toHaveBeenCalled();
  });
});

describe('scheduleFollowSheetAc', () => {
  it('debounces a burst into one follow', async () => {
    vi.useFakeTimers();
    try {
      const session = room();
      const loadAc = vi.fn(async () => 18);
      const { deps: d } = deps(session, loadAc);
      scheduleFollowSheetAc('c1', d, 500);
      await vi.advanceTimersByTimeAsync(300);
      scheduleFollowSheetAc('c1', d, 500);
      await vi.advanceTimersByTimeAsync(300);
      expect(loadAc).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(loadAc).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
