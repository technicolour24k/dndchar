import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { attachVttWebSocketServer } from '../../../vtt/server/wsServer.js';
import { createSession, sessions, socketsBySession } from '../../../vtt/server/store.js';

// Real sockets against the real ws layer: an account GM's gmSocketId (their user id) must clear
// when their socket closes, which the old meta.playerId comparison never did.
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

async function connectGm(sessionId: string, playerId?: string) {
  const ws = new WebSocket(`ws://localhost:${port}/vtt-ws`);
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  const joined = new Promise<void>((resolve) => ws.on('message', (data) => {
    if (JSON.parse(String(data)).type === 'state:full') resolve();
  }));
  ws.send(JSON.stringify({ type: 'join', sessionId, role: 'gm', playerId }));
  await joined;
  return ws;
}

async function closeAndWait(ws: WebSocket, sessionId: string) {
  const closed = new Promise<void>((resolve) => ws.on('close', () => resolve()));
  ws.close();
  await closed;
  // The server's own close handler runs a tick after the client sees the close.
  for (let i = 0; i < 50 && socketsBySession.get(sessionId)?.size; i++) await new Promise((r) => setTimeout(r, 10));
}

describe('GM disconnect clears gmSocketId', () => {
  it('clears for an account GM', async () => {
    sessions.set('GMCLOSE1', createSession('GMCLOSE1'));
    const ws = await connectGm('GMCLOSE1', 'user-1');
    expect(sessions.get('GMCLOSE1').gmSocketId).toBe('user-1');
    await closeAndWait(ws, 'GMCLOSE1');
    expect(sessions.get('GMCLOSE1').gmSocketId).toBeNull();
  });

  it('still clears for a placeholder GM', async () => {
    sessions.set('GMCLOSE2', createSession('GMCLOSE2'));
    const ws = await connectGm('GMCLOSE2');
    expect(sessions.get('GMCLOSE2').gmSocketId).toBe('gm');
    await closeAndWait(ws, 'GMCLOSE2');
    expect(sessions.get('GMCLOSE2').gmSocketId).toBeNull();
  });
});
