import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { attachVttWebSocketServer } from '../../../vtt/server/wsServer.js';
import { createSession, disconnectUserFromRoom, ensureRoom, issueJoinTicket, joinTickets, revokeJoinTickets, sessions, setGmSeat, socketsBySession } from '../../../vtt/server/store.js';
import { isRoomGm } from './vttForage';

// Real sockets against the real ws layer (same approach as vttGmClose.test.ts, on an ephemeral
// port, never 5173): campaign rooms accept only ticketed joins, identity comes from the ticket,
// and the GM seat follows the primary DM / co-DM rules in handlers/join.js.
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
  joinTickets.clear();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Client = { ws: WebSocket; messages: any[]; closed: Promise<number>; next: (type: string) => Promise<any> };

async function connect(): Promise<Client> {
  const ws = new WebSocket(`ws://localhost:${port}/vtt-ws`);
  open.push(ws);
  const messages: any[] = [];
  const waiters: Array<{ type: string; resolve: (m: any) => void }> = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.type === msg.type) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
    }
  });
  const closed = new Promise<number>((resolve) => ws.on('close', (code) => resolve(code)));
  await new Promise<void>((resolve, reject) => { ws.on('open', () => resolve()); ws.on('error', reject); });
  // Resolves with an already-received message of that type, or waits for the next one.
  const next = (type: string) => {
    const seen = messages.find((m) => m.type === type);
    if (seen) return Promise.resolve(seen);
    return new Promise<any>((resolve) => waiters.push({ type, resolve }));
  };
  return { ws, messages, closed, next };
}

const send = (client: Client, msg: object) => client.ws.send(JSON.stringify(msg));
// Waits for whichever of the two join outcomes arrives.
const outcome = (client: Client) => Promise.race([client.next('state:full'), client.next('join:error')]);

const ROOM = 'CAMPRM01';
const gmTicket = (userId: string, seat: 'primary' | 'co', takeoverOf: 'self' | 'co' | null = null, sessionId = ROOM) =>
  issueJoinTicket({ sessionId, userId, displayName: userId, role: 'gm', seat, takeoverOf });
const playerTicket = (userId: string, sessionId = ROOM) =>
  issueJoinTicket({ sessionId, userId, displayName: userId, role: 'player', seat: null });

async function joinWith(ticket: string | undefined, extra: object = {}, sessionId = ROOM) {
  const client = await connect();
  send(client, { type: 'join', sessionId, ticket, ...extra });
  return { client, result: await outcome(client) };
}

// Tests start from a clean room each time.
function freshRoom(campaignId: string | null = 'camp-1', id = ROOM) {
  sessions.delete(id);
  socketsBySession.delete(id);
  return campaignId ? ensureRoom(id, campaignId) : (sessions.set(id, createSession(id)), socketsBySession.set(id, new Set()), sessions.get(id));
}

describe('ticketed joins to a campaign room', () => {
  it('seats a ticketed GM from the ticket alone, ignoring the message', async () => {
    const session = freshRoom();
    const { client, result } = await joinWith(gmTicket('dm-1', 'primary'), { role: 'player', playerId: 'someone-else', playerName: 'Mallory' });
    expect(result.type).toBe('state:full');
    expect(session.gmSocketId).toBe('dm-1');
    expect(isRoomGm(session, 'dm-1')).toBe(true);
    expect(isRoomGm(session, 'someone-else')).toBe(false);
    expect(client).toBeTruthy();
  });

  it('a player ticket can never become GM, even if the message says role gm', async () => {
    const session = freshRoom();
    const { result } = await joinWith(playerTicket('p-1'), { role: 'gm', playerId: 'dm-1' });
    expect(result.type).toBe('state:full');
    expect(session.gmSocketId).toBeNull();
    expect(session.players['p-1']).toMatchObject({ id: 'p-1', name: 'p-1', connected: true });
    expect(session.players['dm-1']).toBeUndefined();
  });

  it('rejects a ticket issued for another room', async () => {
    freshRoom();
    freshRoom('camp-2', 'CAMPRM02');
    const { result } = await joinWith(gmTicket('dm-1', 'primary', null, 'CAMPRM02'));
    expect(result).toEqual({ type: 'join:error', reason: 'bad_ticket' });
    expect(sessions.get(ROOM).gmSocketId).toBeNull();
    sessions.delete('CAMPRM02');
    socketsBySession.delete('CAMPRM02');
  });

  it('rejects a reused ticket and an unknown one', async () => {
    freshRoom();
    const ticket = playerTicket('p-1');
    expect((await joinWith(ticket)).result.type).toBe('state:full');
    expect((await joinWith(ticket)).result).toEqual({ type: 'join:error', reason: 'bad_ticket' });
    expect((await joinWith('not-a-ticket')).result).toEqual({ type: 'join:error', reason: 'bad_ticket' });
  });

  it('refuses a ticket-less join, including a crafted GM join with a DM id', async () => {
    const session = freshRoom();
    const plain = await joinWith(undefined, { role: 'player', playerId: 'p-1', playerName: 'P' });
    expect(plain.result).toEqual({ type: 'join:error', reason: 'ticket_required' });
    const crafted = await joinWith(undefined, { role: 'gm', playerId: 'dm-1' });
    expect(crafted.result).toEqual({ type: 'join:error', reason: 'ticket_required' });
    expect(session.gmSocketId).toBeNull();
    expect(Object.keys(session.players)).toHaveLength(0);
  });
});

describe('Quick rooms are unchanged', () => {
  it('still takes role and playerId from the message, first live GM wins', async () => {
    const session = freshRoom(null, 'QUICK1');
    const first = await joinWith(undefined, { role: 'gm', playerId: 'user-1' }, 'QUICK1');
    expect(first.result.type).toBe('state:full');
    expect(session.gmSocketId).toBe('user-1');
    const second = await joinWith(undefined, { role: 'gm', playerId: 'user-2' }, 'QUICK1');
    expect(second.result).toEqual({ type: 'join:error', reason: 'gm_already_claimed' });
    const player = await joinWith(undefined, { role: 'player', playerId: 'p-9', playerName: 'Nine' }, 'QUICK1');
    expect(player.result.type).toBe('state:full');
    expect(session.players['p-9'].name).toBe('Nine');
    sessions.delete('QUICK1');
    socketsBySession.delete('QUICK1');
  });
});

describe('GM seat', () => {
  it('offers the primary DM a takeover when the co-DM holds the seat, and takes nothing yet', async () => {
    const session = freshRoom();
    await joinWith(gmTicket('co-1', 'co'));
    const { result } = await joinWith(gmTicket('dm-1', 'primary'));
    expect(result).toEqual({ type: 'join:error', reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'other' });
    expect(session.gmSocketId).toBe('co-1');
  });

  it('takeover: the co-DM is told and closed (4002), the primary holds the seat afterwards', async () => {
    const session = freshRoom();
    const co = (await joinWith(gmTicket('co-1', 'co'))).client;
    const { result } = await joinWith(gmTicket('dm-1', 'primary', 'co'));
    expect(result.type).toBe('state:full');
    expect((await co.next('gm:replaced')).type).toBe('gm:replaced');
    expect(await co.closed).toBe(4002);
    // Give the old socket's server-side close handler a moment to run, then check it didn't unseat the new GM.
    await new Promise((r) => setTimeout(r, 50));
    expect(session.gmSocketId).toBe('dm-1');
    expect(isRoomGm(session, 'dm-1')).toBe(true);
    expect(isRoomGm(session, 'co-1')).toBe(false);
  });

  it('the co-DM cannot take the seat from the primary DM', async () => {
    const session = freshRoom();
    await joinWith(gmTicket('dm-1', 'primary'));
    const { result } = await joinWith(gmTicket('co-1', 'co'));
    expect(result).toEqual({ type: 'join:error', reason: 'gm_already_claimed' });
    expect(session.gmSocketId).toBe('dm-1');
  });

  it('a second tab of the seat holder is offered a takeover, and a takeover ticket replaces their own old socket', async () => {
    const session = freshRoom();
    const old = (await joinWith(gmTicket('dm-1', 'primary'))).client;
    expect((await joinWith(gmTicket('dm-1', 'primary'))).result).toEqual({ type: 'join:error', reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'self' });
    const { result } = await joinWith(gmTicket('dm-1', 'primary', 'self'));
    expect(result.type).toBe('state:full');
    expect((await old.next('gm:replaced')).type).toBe('gm:replaced');
    expect(await old.closed).toBe(4002);
    await new Promise((r) => setTimeout(r, 50));
    // The old socket release must not unseat the replacement (same user id).
    expect(session.gmSocketId).toBe('dm-1');
    expect(isRoomGm(session, 'dm-1')).toBe(true);
  });

  it('the co-DM can take over from their own stale socket, but still not from the primary', async () => {
    const session = freshRoom();
    const old = (await joinWith(gmTicket('co-1', 'co'))).client;
    expect((await joinWith(gmTicket('co-1', 'co'))).result).toEqual({ type: 'join:error', reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'self' });
    expect((await joinWith(gmTicket('co-1', 'co', 'self'))).result.type).toBe('state:full');
    expect(await old.closed).toBe(4002);
    // The primary then takes the seat from the co-DM, and a co-DM asking with takeover is refused.
    await joinWith(gmTicket('dm-1', 'primary', 'co'));
    expect((await joinWith(gmTicket('co-1', 'co', 'co'))).result).toEqual({ type: 'join:error', reason: 'gm_already_claimed' });
    expect(session.gmSocketId).toBe('dm-1');
  });

  // The race the client can't see: it was told the seat is its own stale socket (heldBy 'self'), the
  // stale socket closed, the co-DM sat down, and only then does the takeoverOf:'self' ticket arrive.
  it('a self takeover ticket does not displace a co-DM who took the seat in the meantime', async () => {
    const session = freshRoom();
    const co = (await joinWith(gmTicket('co-1', 'co'))).client;
    const { result } = await joinWith(gmTicket('dm-1', 'primary', 'self'));
    expect(result).toEqual({ type: 'join:error', reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'other' });
    expect(session.gmSocketId).toBe('co-1');
    expect(isRoomGm(session, 'co-1')).toBe(true);
    expect(co.ws.readyState).toBe(WebSocket.OPEN);
  });

  it('a co takeover ticket does nothing once the seat is the asker own socket (and not the other way round)', async () => {
    const session = freshRoom();
    await joinWith(gmTicket('dm-1', 'primary'));
    // 'co' intent but the holder is the asker themself: not the situation it was issued for.
    expect((await joinWith(gmTicket('dm-1', 'primary', 'co'))).result).toEqual({ type: 'join:error', reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'self' });
    expect(session.gmSocketId).toBe('dm-1');
  });

  it('after a role swap the seated user rank is updated, so the new primary is offered a takeover', async () => {
    const session = freshRoom();
    // dm-1 sits in the seat as primary, then is swapped to co-DM (seated, keeps the seat).
    await joinWith(gmTicket('dm-1', 'primary'));
    setGmSeat(ROOM, 'dm-1', 'co');
    const { result } = await joinWith(gmTicket('co-1', 'primary'));
    expect(result).toEqual({ type: 'join:error', reason: 'gm_seat_taken', canTakeOver: true, heldBy: 'other' });
    expect(session.gmSocketId).toBe('dm-1');
  });

  it('a stale claim is reclaimable by either DM without a takeover', async () => {
    const session = freshRoom();
    const co = (await joinWith(gmTicket('co-1', 'co'))).client;
    co.ws.close();
    await co.closed;
    await new Promise((r) => setTimeout(r, 50));
    const { result } = await joinWith(gmTicket('dm-1', 'primary'));
    expect(result.type).toBe('state:full');
    expect(session.gmSocketId).toBe('dm-1');
  });
});

describe('revocation, room hopping and kicks releasing the seat', () => {
  it('a ticket revoked before it is used gets bad_ticket', async () => {
    freshRoom();
    const ticket = playerTicket('p-1');
    revokeJoinTickets(ROOM, 'p-1');
    expect((await joinWith(ticket)).result).toEqual({ type: 'join:error', reason: 'bad_ticket' });
  });

  it('a socket that hops to another room leaves the old room, and a kick there no longer reaches it', async () => {
    const roomA = freshRoom('camp-1', 'HOPROOMA');
    const roomB = freshRoom('camp-2', 'HOPROOMB');
    const client = await connect();
    send(client, { type: 'join', sessionId: 'HOPROOMA', ticket: playerTicket('p-1', 'HOPROOMA') });
    await client.next('state:full');
    expect(socketsBySession.get('HOPROOMA')!.size).toBe(1);
    client.messages.length = 0;
    send(client, { type: 'join', sessionId: 'HOPROOMB', ticket: playerTicket('p-1', 'HOPROOMB') });
    await new Promise((r) => setTimeout(r, 50));
    expect(socketsBySession.get('HOPROOMA')!.size).toBe(0);
    expect(socketsBySession.get('HOPROOMB')!.size).toBe(1);
    expect(roomA.players['p-1'].connected).toBe(false);
    expect(roomB.players['p-1'].connected).toBe(true);
    // A kick in the old room finds nothing; a kick in the new room still finds the user via meta.userId.
    disconnectUserFromRoom('HOPROOMA', 'p-1', 'removed_from_campaign');
    expect(client.messages.some((m) => m.type === 'kicked')).toBe(false);
    disconnectUserFromRoom('HOPROOMB', 'p-1', 'removed_from_campaign');
    expect((await client.next('kicked')).reason).toBe('removed_from_campaign');
    for (const id of ['HOPROOMA', 'HOPROOMB']) { sessions.delete(id); socketsBySession.delete(id); }
  });

  it('a GM socket hopping away releases its seat in the old room', async () => {
    const roomA = freshRoom('camp-1', 'HOPROOMA');
    freshRoom('camp-2', 'HOPROOMB');
    const client = await connect();
    send(client, { type: 'join', sessionId: 'HOPROOMA', ticket: gmTicket('dm-1', 'primary', null, 'HOPROOMA') });
    await client.next('state:full');
    expect(roomA.gmSocketId).toBe('dm-1');
    send(client, { type: 'join', sessionId: 'HOPROOMB', ticket: playerTicket('dm-1', 'HOPROOMB') });
    await new Promise((r) => setTimeout(r, 50));
    expect(roomA.gmSocketId).toBeNull();
    for (const id of ['HOPROOMA', 'HOPROOMB']) { sessions.delete(id); socketsBySession.delete(id); }
  });

  it('kicking a seated co-DM releases the seat at once', async () => {
    const session = freshRoom();
    const { client } = await joinWith(gmTicket('co-1', 'co'));
    expect(session.gmSocketId).toBe('co-1');
    disconnectUserFromRoom(ROOM, 'co-1', 'role_changed');
    expect(session.gmSocketId).toBeNull();
    expect(socketsBySession.get(ROOM)!.size).toBe(0);
    expect(await client.closed).toBe(4001);
    // So the primary can sit without any takeover.
    expect((await joinWith(gmTicket('dm-1', 'primary'))).result.type).toBe('state:full');
  });
});

describe('kicking a user from a live room', () => {
  it('sends kicked and closes with 4001', async () => {
    freshRoom();
    const { client } = await joinWith(playerTicket('p-1'));
    disconnectUserFromRoom(ROOM, 'p-1', 'removed_from_campaign');
    expect((await client.next('kicked')).reason).toBe('removed_from_campaign');
    expect(await client.closed).toBe(4001);
  });
});
