import { describe, expect, it } from 'vitest';
// Relative imports: the VTT server code lives outside src/ (same as vttRollText.test.ts).
import handleTokenEvent, { clearMovePreviewForSocket } from '../../../vtt/server/handlers/token.js';

// Grid 50px, so one square = 5 ft.
const G = 50;

type Meta = Record<string, any>;
const gm: Meta = { role: 'gm', playerId: null, sessionId: 's1', movePreviewTokenId: null };
const owner: Meta = { role: 'player', playerId: 'p1', sessionId: 's1', movePreviewTokenId: null };
const other: Meta = { role: 'player', playerId: 'p2', sessionId: 's1', movePreviewTokenId: null };
const watcher: Meta = { role: 'watcher', playerId: null };

function makeSession(tokenOverrides: Record<string, unknown> = {}, mapOverrides: Record<string, unknown> | null = {}) {
  return {
    map: mapOverrides === null ? null : { gridSizePx: G, widthPx: 1000, heightPx: 600, revealed: true, ...mapOverrides },
    tokens: {
      t1: { id: 't1', ownerId: 'p1', x: 100, y: 100, speedFt: 30, speedRemainingFt: 30, hidden: false, ...tokenOverrides },
      t2: { id: 't2', ownerId: 'p1', x: 300, y: 300, hidden: false }
    } as Record<string, any>
  };
}

// Runs one event. Every recipient meta is offered the payload; results are keyed by name and
// hold every payload that recipient received (a preview can emit a clear first).
function run(session: any, sender: Meta, msg: Record<string, unknown>, recipients: Record<string, Meta> = { gm, owner, other, watcher }) {
  const results: Record<string, any[]> = {};
  let broadcasts = 0;
  const context = {
    sessions: new Map([['s1', session]]),
    broadcast: (_sid: string, build: (r: Meta) => unknown) => {
      broadcasts++;
      for (const [name, r] of Object.entries(recipients)) {
        const p = build(r);
        if (p) (results[name] ??= []).push(p);
      }
    }
  };
  handleTokenEvent(sender, msg, context);
  return { results, broadcasts };
}

const move = (session: any, sender: Meta, x: number, y: number, extra: Record<string, unknown> = {}) =>
  run(session, sender, { type: 'token:move', tokenId: 't1', x, y, ...extra });

describe('token:move distance', () => {
  it('deducts orthogonal drag distance', () => {
    const s = makeSession();
    move(s, owner, 200, 100);
    expect(s.tokens.t1.speedRemainingFt).toBe(20);
  });

  it('charges a 3x3 diagonal 15 ft (not 21)', () => {
    const s = makeSession();
    move(s, owner, 250, 250);
    expect(s.tokens.t1.speedRemainingFt).toBe(15);
  });

  it('charges a 3x1 mixed move 15 ft', () => {
    const s = makeSession();
    move(s, owner, 250, 150);
    expect(s.tokens.t1.speedRemainingFt).toBe(15);
  });

  it('sums a waypoint path and ends on the final point', () => {
    const s = makeSession();
    const { results } = move(s, owner, 300, 200, { waypoints: [{ x: 200, y: 100 }] });
    expect(s.tokens.t1.speedRemainingFt).toBe(10); // 10 + 10 ft
    expect(s.tokens.t1.x).toBe(300);
    expect(s.tokens.t1.y).toBe(200);
    // Waypoints are not echoed.
    expect(results.gm[0].waypoints).toBeUndefined();
  });

  it('moves anyway when over budget, clamping at 0', () => {
    const s = makeSession({ speedRemainingFt: 10 });
    move(s, owner, 400, 100, { waypoints: [{ x: 200, y: 100 }] });
    expect(s.tokens.t1.speedRemainingFt).toBe(0);
    expect(s.tokens.t1.x).toBe(400);
  });

  it('does not deduct for props, or with no map', () => {
    const prop = makeSession({ speedRemainingFt: undefined });
    expect(() => move(prop, gm, 300, 100)).not.toThrow();
    expect(prop.tokens.t1.x).toBe(300);
    expect(prop.tokens.t1.speedRemainingFt).toBeUndefined();

    const noMap = makeSession({}, null);
    expect(() => move(noMap, gm, 300, 100)).not.toThrow();
    expect(noMap.tokens.t1.x).toBe(300);
    expect(noMap.tokens.t1.speedRemainingFt).toBe(30);
  });

  it('rejects bad moves without changing the token or broadcasting', () => {
    const cases: [Meta, Record<string, unknown>][] = [
      [other, {}],
      [owner, { x: NaN }],
      [owner, { waypoints: 'nope' }],
      [owner, { waypoints: Array.from({ length: 50 }, () => ({ x: 150, y: 100 })) }],
      [owner, { waypoints: [{ x: 150, y: 'abc' }] }]
    ];
    for (const [sender, extra] of cases) {
      const s = makeSession();
      const { broadcasts } = move(s, sender, 200, 100, extra);
      expect(broadcasts).toBe(0);
      expect(s.tokens.t1.x).toBe(100);
      expect(s.tokens.t1.speedRemainingFt).toBe(30);
    }
  });

  it('cannot be under-charged with sub-foot waypoint spam', () => {
    const s = makeSession();
    // 49 waypoints each 1px apart (0.1 ft, rounds to 0 per leg), then the real destination.
    const waypoints = Array.from({ length: 49 }, (_, i) => ({ x: 100 + i, y: 100 }));
    move(s, owner, 300, 100, { waypoints });
    // Straight distance is 200px = 20 ft, so at least that must be charged.
    expect(s.tokens.t1.speedRemainingFt).toBeLessThanOrEqual(10);
  });

  it('accepts exactly 49 waypoints', () => {
    const s = makeSession();
    const { broadcasts } = move(s, owner, 200, 100, { waypoints: Array.from({ length: 49 }, () => ({ x: 150, y: 100 })) });
    expect(broadcasts).toBe(1);
  });

  it('hides moves of hidden tokens, or on an unrevealed map, from players', () => {
    const hidden = makeSession({ hidden: true });
    const r1 = move(hidden, gm, 200, 100).results;
    expect(r1.gm).toBeTruthy();
    expect(r1.owner).toBeUndefined();
    expect(r1.other).toBeUndefined();

    const unrevealed = makeSession({}, { revealed: false });
    const r2 = move(unrevealed, gm, 200, 100).results;
    expect(r2.gm).toBeTruthy();
    expect(r2.owner).toBeUndefined();
  });
});

describe('token:recenter', () => {
  const recenter = (s: any, sender: Meta) => run(s, sender, { type: 'token:recenter', tokenId: 't1' });

  it('moves to the map centre without costing movement', () => {
    const s = makeSession({ x: 5000, y: 5000 });
    const { results } = recenter(s, owner);
    expect(s.tokens.t1.x).toBe(500);
    expect(s.tokens.t1.y).toBe(300);
    expect(s.tokens.t1.speedRemainingFt).toBe(30);
    expect(results.gm[0]).toMatchObject({ type: 'token:move', tokenId: 't1', x: 500, y: 300, speedRemainingFt: 30 });
  });

  it('ignores client-supplied coordinates', () => {
    const s = makeSession();
    run(s, owner, { type: 'token:recenter', tokenId: 't1', x: 1, y: 2 });
    expect(s.tokens.t1.x).toBe(500);
  });

  it('keeps the same permission rule as token:move', () => {
    const s = makeSession();
    const { broadcasts } = recenter(s, other);
    expect(broadcasts).toBe(0);
    expect(s.tokens.t1.x).toBe(100);
    expect(recenter(s, gm).broadcasts).toBe(1);
  });

  it('does nothing without a map', () => {
    const s = makeSession({}, null);
    expect(recenter(s, gm).broadcasts).toBe(0);
  });

  it('is hidden from players for a hidden token', () => {
    const s = makeSession({ hidden: true });
    const { results } = recenter(s, gm);
    expect(results.gm).toBeTruthy();
    expect(results.owner).toBeUndefined();
  });
});

describe('token:move:preview', () => {
  const pts = [{ x: 150, y: 100 }];
  const preview = (s: any, sender: Meta, msg: Record<string, unknown> = {}) =>
    run(s, sender, { type: 'token:move:preview', tokenId: 't1', points: pts, ...msg });

  it('reaches the GM and other players but not the sender', () => {
    const sender = { ...owner };
    const { results } = preview(makeSession(), sender, {}); // sender is not in the default recipients
    expect(results.gm[0]).toEqual({ type: 'token:move:preview', tokenId: 't1', points: pts });
    expect(results.other[0].type).toBe('token:move:preview');
    expect(sender.movePreviewTokenId).toBe('t1');

    // With the sender itself among the recipients, it gets nothing.
    const again = run(makeSession(), sender, { type: 'token:move:preview', tokenId: 't1', points: pts }, { sender, gm, other });
    expect(again.results.sender).toBeUndefined();
    expect(again.results.gm).toBeTruthy();
  });

  it('only copies x and y from points', () => {
    const { results } = preview(makeSession(), { ...owner }, { points: [{ x: 1, y: 2, evil: true }] });
    expect(results.gm[0].points).toEqual([{ x: 1, y: 2 }]);
  });

  it('gives hidden tokens and unrevealed maps to the GM only (watchers too)', () => {
    for (const s of [makeSession({ hidden: true }), makeSession({}, { revealed: false })]) {
      const { results } = preview(s, { ...owner });
      expect(results.gm).toBeTruthy();
      expect(results.other).toBeUndefined();
      expect(results.watcher).toBeUndefined();
    }
  });

  it('gives the watcher the player-filtered result without throwing', () => {
    const { results } = preview(makeSession(), { ...owner });
    expect(results.watcher[0].type).toBe('token:move:preview');
  });

  it('ignores a non-owner player and a session with no map', () => {
    expect(preview(makeSession(), { ...other }).broadcasts).toBe(0);
    expect(preview(makeSession({}, null), { ...owner }).broadcasts).toBe(0);
  });

  it('ignores 0 points, 51 points and a NaN point', () => {
    expect(preview(makeSession(), { ...owner }, { points: [] }).broadcasts).toBe(0);
    expect(preview(makeSession(), { ...owner }, { points: Array.from({ length: 51 }, () => ({ x: 1, y: 1 })) }).broadcasts).toBe(0);
    expect(preview(makeSession(), { ...owner }, { points: [{ x: NaN, y: 1 }] }).broadcasts).toBe(0);
    expect(preview(makeSession(), { ...owner }, { points: Array.from({ length: 50 }, () => ({ x: 1, y: 1 })) }).broadcasts).toBe(1);
  });

  it('clears the previous token first when the plan moves to another token', () => {
    const s = makeSession();
    const sender = { ...owner };
    preview(s, sender);
    const { results } = run(s, sender, { type: 'token:move:preview', tokenId: 't2', points: pts });
    expect(results.gm.map((p: any) => [p.type, p.tokenId])).toEqual([
      ['token:move:preview:clear', 't1'],
      ['token:move:preview', 't2']
    ]);
    expect(sender.movePreviewTokenId).toBe('t2');
  });

  it('relays clear and resets movePreviewTokenId', () => {
    const s = makeSession();
    const sender = { ...owner };
    preview(s, sender);
    const { results } = run(s, sender, { type: 'token:move:preview:clear', tokenId: 't1' });
    expect(results.gm[0]).toEqual({ type: 'token:move:preview:clear', tokenId: 't1' });
    expect(sender.movePreviewTokenId).toBeNull();
    // A non-owner clear is ignored.
    expect(run(s, { ...other }, { type: 'token:move:preview:clear', tokenId: 't1' }).broadcasts).toBe(0);
  });

  it('a committed move resets the sender plan', () => {
    const s = makeSession();
    const sender = { ...owner };
    preview(s, sender);
    move(s, sender, 200, 100);
    expect(sender.movePreviewTokenId).toBeNull();
  });
});

describe('private GM previews', () => {
  const coGm = { role: 'gm', playerId: 'gm2', sessionId: 's1' };
  const everyone = { gm, coGm, owner, other, watcher };
  const sendPreview = (sender: Meta, extra: Record<string, unknown>) =>
    run(makeSession(), sender, { type: 'token:move:preview', tokenId: 't1', points: [{ x: 150, y: 100 }], ...extra }, everyone);

  it('reaches GM-role recipients only', () => {
    const { results } = sendPreview({ ...gm }, { private: true });
    expect(results.coGm).toBeTruthy();
    expect(results.owner).toBeUndefined();
    expect(results.other).toBeUndefined();
    expect(results.watcher).toBeUndefined();
  });

  it('is public without the flag', () => {
    const { results } = sendPreview({ ...gm }, {});
    expect(results.owner).toBeTruthy();
    expect(results.other).toBeTruthy();
  });

  it('a clear for a private plan reaching players is harmless (same payload, no plan to remove)', () => {
    const sender = { ...gm };
    sendPreview(sender, { private: true });
    const { results } = run(makeSession(), sender, { type: 'token:move:preview:clear', tokenId: 't1' }, everyone);
    expect(results.owner[0]).toEqual({ type: 'token:move:preview:clear', tokenId: 't1' });
    expect(results.other[0]).toEqual({ type: 'token:move:preview:clear', tokenId: 't1' });
  });

  it('is ignored for players, whose plans are always visible', () => {
    const { results } = sendPreview({ ...owner }, { private: true });
    expect(results.gm).toBeTruthy();
    expect(results.other).toBeTruthy();
  });
});

describe('clearMovePreviewForSocket', () => {
  const collect = (session: any, meta: Meta) => {
    const sent: any[] = [];
    clearMovePreviewForSocket(meta, session, (_sid: string, build: (r: Meta) => unknown) => {
      for (const r of [gm, other, watcher]) {
        const p = build(r);
        if (p) sent.push(p);
      }
    });
    return sent;
  };

  it('emits a clear when a plan is set, and resets the field', () => {
    const meta = { ...owner, movePreviewTokenId: 't1' };
    const sent = collect(makeSession(), meta);
    expect(sent.length).toBe(3);
    expect(sent[0]).toEqual({ type: 'token:move:preview:clear', tokenId: 't1' });
    expect(meta.movePreviewTokenId).toBeNull();
  });

  it('emits nothing when unset or when the token is gone', () => {
    expect(collect(makeSession(), { ...owner, movePreviewTokenId: null })).toEqual([]);
    const meta = { ...owner, movePreviewTokenId: 'gone' };
    expect(collect(makeSession(), meta)).toEqual([]);
    expect(meta.movePreviewTokenId).toBeNull();
  });
});
