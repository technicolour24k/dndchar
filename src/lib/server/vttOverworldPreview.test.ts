import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { attachVttWebSocketServer } from '../../../vtt/server/wsServer.js';
import {
  clearOverworldPreview, closeOverworldLive, consumeOverworldLiveTicket, issueOverworldLiveTicket, joinOverworldLive,
  PREVIEW_IDLE_MS, relayOverworldPreview
} from '../../../vtt/server/store.js';

// Unit G: the live route-preview channel. Real sockets on an ephemeral port (never 5173) for the
// ticket/visibility/clear behaviour, fake metas for throttling and the idle timeout.
let server: http.Server;
let port: number;
const open: WebSocket[] = [];

beforeAll(async () => {
  server = http.createServer();
  attachVttWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});
afterEach(() => {
  for (const ws of open.splice(0)) ws.terminate();
  vi.useRealTimers();
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Client = { ws: WebSocket; messages: any[]; closed: Promise<number> };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/vtt-ws`);
  open.push(ws);
  const messages: any[] = [];
  ws.on('message', (d) => messages.push(JSON.parse(String(d))));
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  return { ws, messages, closed };
}
const send = (c: Client, msg: object) => c.ws.send(JSON.stringify(msg));

const MAP = 'map-1';
const ticketFor = (userId: string, isDm = false, mapId = MAP) =>
  issueOverworldLiveTicket({ campaignId: 'camp-1', mapId, userId, displayName: `Name ${userId}`, isDm });

async function joined(userId: string, isDm = false, mapId = MAP): Promise<Client> {
  const c = await connect();
  send(c, { type: 'overworld:live:join', ticket: ticketFor(userId, isDm, mapId) });
  while (!c.messages.some((m) => m.type === 'overworld:live:joined')) await wait(5);
  return c;
}
const frame = (extra: object = {}) => ({
  type: 'overworld:preview', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }], visibility: 'everyone', colour: '#ffffff', ...extra
});
const previews = (c: Client) => c.messages.filter((m) => m.type === 'overworld:preview');
const clears = (c: Client) => c.messages.filter((m) => m.type === 'overworld:preview:clear');

describe('tickets', () => {
  it('a ticket is required, and works once only', async () => {
    const a = await connect();
    send(a, { type: 'overworld:live:join', ticket: 'nope' });
    send(a, { type: 'overworld:live:join' });
    await wait(40);
    expect(a.messages.map((m) => m.type)).toEqual(['overworld:live:error', 'overworld:live:error']);

    const ticket = ticketFor('p1');
    expect(consumeOverworldLiveTicket(ticket)).toMatchObject({ mapId: MAP, userId: 'p1' });
    expect(consumeOverworldLiveTicket(ticket)).toBeNull();
  });
});

describe('who receives a preview', () => {
  it('a private preview reaches the drawer\'s other tab and DMs, not another player', async () => {
    const drawer = await joined('p1');
    const drawerTab2 = await joined('p1');
    const dm = await joined('dm', true);
    const other = await joined('p2');
    send(drawer, frame({ visibility: 'private' }));
    await wait(60);
    expect(previews(dm)).toHaveLength(1);
    expect(previews(drawerTab2)).toHaveLength(1);
    expect(previews(other)).toHaveLength(0);
    expect(previews(drawer)).toHaveLength(0);
  });

  it('a public preview reaches everyone on that map and nobody on another map; payload has no ids', async () => {
    const drawer = await joined('p1');
    const watcher = await joined('p2');
    const elsewhere = await joined('p3', false, 'map-2');
    send(drawer, frame());
    await wait(60);
    expect(previews(elsewhere)).toHaveLength(0);
    const got = previews(watcher);
    expect(got).toHaveLength(1);
    expect(Object.keys(got[0]).sort()).toEqual(['colour', 'drawerName', 'points', 'previewId', 'type', 'visibility']);
    expect(got[0]).toMatchObject({ drawerName: 'Name p1', visibility: 'everyone', colour: '#ffffff', points: [{ x: 0.1, y: 0.2 }, { x: 0.3, y: 0.4 }] });
  });

  it('switching to private mid-draw clears it for the players who saw it', async () => {
    const drawer = await joined('p1');
    const player = await joined('p2');
    const dm = await joined('dm', true);
    send(drawer, frame());
    await wait(150);
    send(drawer, frame({ visibility: 'private' }));
    await wait(60);
    expect(clears(player)).toHaveLength(1);
    expect(clears(dm)).toHaveLength(0);
    expect(previews(dm)).toHaveLength(2);
    expect(previews(player)).toHaveLength(1);
  });
});

describe('frames and clearing', () => {
  it('malformed frames are dropped', async () => {
    const drawer = await joined('p1');
    const watcher = await joined('p2');
    const tooMany = Array.from({ length: 202 }, () => ({ x: 0.5, y: 0.5 }));
    const bad = [
      frame({ points: [] }), frame({ points: [{ x: 2, y: 0.1 }] }), frame({ points: [{ x: 'a', y: 0.1 }] }),
      frame({ points: [{ x: NaN, y: 0.1 }] }), frame({ points: tooMany }), frame({ visibility: 'secret' }),
      frame({ colour: 'red' }), frame({ points: 'x' })
    ];
    for (const b of bad) {
      send(drawer, b);
      await wait(110); // past the rate limit so only validation can drop it
    }
    expect(previews(watcher)).toHaveLength(0);
  });

  it('clear and disconnect both send overworld:preview:clear to the others', async () => {
    const drawer = await joined('p1');
    const watcher = await joined('p2');
    send(drawer, frame());
    await wait(60);
    send(drawer, { type: 'overworld:preview:clear' });
    await wait(60);
    expect(clears(watcher)).toHaveLength(1);
    expect(clears(watcher)[0].previewId).toBe(previews(watcher)[0].previewId);

    await wait(110);
    send(drawer, frame());
    await wait(60);
    drawer.ws.close();
    await wait(80);
    expect(clears(watcher)).toHaveLength(2);
  });

  it('rights removed (unshare) closes the players\' preview sockets but not the DM\'s, and revokes tickets', async () => {
    const player = await joined('p1');
    const dm = await joined('dm', true);
    const spare = ticketFor('p1');
    closeOverworldLive((t: any) => t.mapId === MAP && !t.isDm);
    expect(await player.closed).toBe(4003);
    expect(dm.ws.readyState).toBe(WebSocket.OPEN);
    expect(consumeOverworldLiveTicket(spare)).toBeNull();
  });
});

describe('throttling and idle timeout (fake sockets)', () => {
  const fakeMeta = (userId: string) => {
    const sent: any[] = [];
    const meta: any = { ws: { OPEN: 1, readyState: 1, send: (m: string) => sent.push(JSON.parse(m)) } };
    joinOverworldLive(meta, { campaignId: 'c', mapId: 'map-fake', userId, displayName: userId, isDm: false });
    return { meta, sent };
  };
  const msg = { points: [{ x: 0.1, y: 0.1 }], visibility: 'everyone', colour: '#112233' };

  it('drops frames faster than 10 a second', () => {
    const a = fakeMeta('a');
    const b = fakeMeta('b');
    expect(relayOverworldPreview(a.meta, msg, 1000)).toBe(true);
    expect(relayOverworldPreview(a.meta, msg, 1050)).toBe(false);
    expect(relayOverworldPreview(a.meta, msg, 1100)).toBe(true);
    expect(b.sent).toHaveLength(2);
    clearOverworldPreview(a.meta);
  });

  it('a preview nobody refreshes clears itself', () => {
    vi.useFakeTimers();
    const a = fakeMeta('a');
    const b = fakeMeta('b');
    relayOverworldPreview(a.meta, msg);
    vi.advanceTimersByTime(PREVIEW_IDLE_MS + 10);
    expect(b.sent.map((m) => m.type)).toEqual(['overworld:preview', 'overworld:preview:clear']);
  });
});
