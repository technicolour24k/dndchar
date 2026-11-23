import { afterEach, describe, expect, it, vi } from 'vitest';
import handleTokenEvent from '../../../vtt/server/handlers/token.js';

// sheetAc is server-owned (decks unit 5b): clients can never write it, and token:add derives it.
const gm = { role: 'gm', playerId: null, sessionId: 's1' };
const owner = { role: 'player', playerId: 'p1', sessionId: 's1' };

function run(sender: any, msg: Record<string, unknown>, session: any) {
  handleTokenEvent(sender, msg, { sessions: new Map([['s1', session]]), broadcast: () => {}, internalApiBaseUrl: () => 'http://localhost:1' });
}
afterEach(() => vi.unstubAllGlobals());
const session = (): any => ({ map: null, tokens: { t1: { id: 't1', type: 'pc', ownerId: 'p1', characterId: 'c1', ac: 15, sheetAc: 15 } } });

describe('token sheetAc', () => {
  it('token:add drops a client sheetAc and never seeds it from the token ac; PC tokens ask for a prime', () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    const s = session();
    run(gm, { type: 'token:add', token: { id: 'n1', type: 'pc', characterId: 'c2', ac: 15, sheetAc: 99 } }, s);
    expect(s.tokens.n1.sheetAc).toBeUndefined();
    expect(s.tokens.n1.ac).toBe(15);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body)).toEqual({ roomId: 's1', tokenId: 'n1' });
    run(gm, { type: 'token:add', token: { id: 'n2', type: 'enemy', ac: 14, sheetAc: 3 } }, s);
    run(gm, { type: 'token:add', token: { id: 'n3', type: 'pc', ac: 14 } }, s);
    expect(s.tokens.n2.sheetAc).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1); // enemies and character-less tokens are not primed
  });
  it('token:stat:update and token:update cannot write it, for the GM or the owner', () => {
    const s = session();
    run(gm, { type: 'token:stat:update', tokenId: 't1', stat: 'sheetAc', value: 1 }, s);
    run(owner, { type: 'token:stat:update', tokenId: 't1', stat: 'sheetAc', value: 2 }, s);
    run(gm, { type: 'token:update', tokenId: 't1', patch: { sheetAc: 3, ac: 16 } }, s);
    expect(s.tokens.t1.sheetAc).toBe(15);
    expect(s.tokens.t1.ac).toBe(16);
  });
});
