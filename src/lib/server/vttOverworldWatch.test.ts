import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { attachVttWebSocketServer } from '../../../vtt/server/wsServer.js';
import { watchersByTopic } from '../../../vtt/server/store.js';
import { notifyOverworldChanged } from './overworldNotify';

// Real sockets: a sheet-style watcher can subscribe to `overworld:<campaignId>` and receives the
// content-free overworld:changed ping. The topic is unauthenticated, so the payload is only
// { type, mapId, topic }: no user id and no map content.
let server: http.Server;
let port: number;

beforeAll(async () => {
  server = http.createServer();
  attachVttWebSocketServer(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function connect() {
  const ws = new WebSocket(`ws://localhost:${port}/vtt-ws`);
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  return ws;
}

async function waitForWatchers(topic: string, count: number) {
  for (let i = 0; i < 100 && (watchersByTopic.get(topic)?.size ?? 0) < count; i++) await new Promise((r) => setTimeout(r, 10));
}

const CAMPAIGN = '11111111-2222-4333-8444-555555555555';
const MAP = '99999999-8888-4777-8666-555555555555';

describe('overworld watch topic', () => {
  it('a watcher on overworld:<campaignId> receives overworld:changed with only type, mapId and topic', async () => {
    const ws = await connect();
    const messages: any[] = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    ws.send(JSON.stringify({ type: 'watch', topics: [`overworld:${CAMPAIGN}`] }));
    await waitForWatchers(`overworld:${CAMPAIGN}`, 1);

    notifyOverworldChanged(CAMPAIGN, MAP);
    for (let i = 0; i < 100 && messages.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(messages).toEqual([{ type: 'overworld:changed', mapId: MAP, topic: `overworld:${CAMPAIGN}` }]);
    ws.close();
  });

  it('a malformed overworld topic is not subscribed', async () => {
    const ws = await connect();
    ws.send(JSON.stringify({ type: 'watch', topics: ['overworld:../etc', 'overworld:', `overworld:${'a'.repeat(65)}`] }));
    await new Promise((r) => setTimeout(r, 50));
    expect(watchersByTopic.get('overworld:../etc')?.size ?? 0).toBe(0);
    expect(watchersByTopic.get('overworld:')?.size ?? 0).toBe(0);
    ws.close();
  });
});
