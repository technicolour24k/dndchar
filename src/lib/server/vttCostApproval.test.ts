import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSession, filterSessionForRole, sessions, socketsBySession, watchersByTopic, setWatches } from '../../../vtt/server/store.js';
import { activationSignature } from '$lib/rules/cost';
import type { Activation } from '$lib/types/cost';

// Cost-engine unit 5: the approval request state machine, the override gate, and the three routes,
// with the database, the cost engine and the roll log mocked out.

const CHAR = '11111111-1111-4111-8111-111111111111';
const OTHER_CHAR = '22222222-2222-4222-8222-222222222222';
const INSTANCE = '33333333-3333-4333-8333-333333333333';
const SHORT = [{ label: 'Vowfire', needed: 1, available: 0 }];

const queryMock = vi.fn();
const accessMock = vi.fn();
const previewMock = vi.fn();
const logRollMock = vi.fn(async () => null);

vi.mock('$lib/server/db', () => ({
  query: (...args: unknown[]) => queryMock(...args),
  withTransaction: async (run: (client: unknown) => unknown) => run({})
}));
vi.mock('$lib/server/services/access', () => ({ getCharacterAccess: (...args: unknown[]) => accessMock(...args) }));
vi.mock('$lib/server/services/rollLog', () => ({ logRoll: (...args: unknown[]) => (logRollMock as any)(...args) }));
vi.mock('$lib/server/services/cost-engine', () => ({
  CostShortfallError: class extends Error {
    shortfalls: unknown[];
    constructor(shortfalls: unknown[]) { super("It doesn't look like you've got the capacity to do that."); this.shortfalls = shortfalls; }
  },
  previewActivationCost: (...args: unknown[]) => previewMock(...args)
}));

const state = await import('./vttCostApproval');
const { openCostGate, runWithGate, costShortfallBody } = await import('./vttCostGate');
const { CostShortfallError } = await import('$lib/server/services/cost-engine');
const playerRoute = await import('../../routes/vtt/api/cost-requests/+server');
const mineRoute = await import('../../routes/vtt/api/cost-requests/mine/+server');
const gmRoute = await import('../../routes/vtt/api/session/[id]/cost-requests/+server');

const spell: Activation = { kind: 'spell', instanceId: INSTANCE, slotType: 'standard', slotLevel: 2 };

function sock(role: string, playerId: string | null, extra: Record<string, unknown> = {}) {
  return { ws: { readyState: 1, OPEN: 1, send: vi.fn() }, role, playerId, sessionId: 'ROOM', watchTopics: new Set<string>(), ...extra };
}

/** A live room: GM 'gm-user' (present or gone), player 'u1'. */
function room(gmLive = true) {
  const session: any = createSession('ROOM', { campaignId: 'camp1' });
  session.gmSocketId = 'gm-user';
  session.players = { u1: { id: 'u1', name: 'Alice' } };
  sessions.set('ROOM', session);
  const gm = sock('gm', null, { gmUserId: 'gm-user' });
  const player = sock('player', 'u1');
  const other = sock('player', 'u2');
  gm.ws.readyState = gmLive ? 1 : 3;
  socketsBySession.set('ROOM', new Set([gm, player, other]));
  return { session, gm, player, other };
}

function ask(overrides: Record<string, unknown> = {}) {
  return playerRoute.POST({
    locals: { user: { id: 'u1', displayName: 'Alice' } },
    request: { json: async () => ({ action: 'ask', characterId: CHAR, activation: spell, roomId: 'ROOM', ...overrides }) }
  } as any);
}
function playerAction(body: Record<string, unknown>, userId = 'u1') {
  return playerRoute.POST({ locals: { user: { id: userId, displayName: 'Alice' } }, request: { json: async () => body } } as any);
}
function gmAction(body: Record<string, unknown>, userId = 'gm-user') {
  return gmRoute.POST({ locals: { user: { id: userId, displayName: 'Tony' } }, params: { id: 'ROOM' }, request: { json: async () => body } } as any);
}
function mine(userId = 'u1', characterId = CHAR) {
  return mineRoute.GET({ locals: { user: { id: userId } }, url: new URL(`http://x/vtt/api/cost-requests/mine?characterId=${characterId}&roomId=ROOM`) } as any);
}

/** Puts an approved request on the room, as the GM endpoint would. */
async function approvedRequest(session: any, extra: Record<string, unknown> = {}) {
  expect((await ask()).status).toBe(200);
  const request = session.costRequests[CHAR];
  expect((await gmAction({ action: 'approve', requestId: request.id, ...extra })).status).toBe(200);
  return request;
}

beforeEach(() => {
  sessions.clear();
  socketsBySession.clear();
  watchersByTopic.clear();
  vi.clearAllMocks();
  accessMock.mockResolvedValue({ canAct: true, canView: true, canEdit: true, isOwner: true, isCampaignDm: false, viaAdmin: false });
  queryMock.mockResolvedValue({ rows: [{ name: 'Aria', campaign_id: 'camp1', room_code: 'ROOM', active_vtt_session_id: null }], rowCount: 1 });
  previewMock.mockResolvedValue({ lines: [], shortfalls: SHORT, label: 'Fireball' });
});

describe('ask / withdraw', () => {
  it('stores one request per character, tells the GM everything and the player their own view', async () => {
    const { session, gm, player, other } = room();
    const response = await ask();
    expect(response.status).toBe(200);
    const request = session.costRequests[CHAR];
    expect(request).toMatchObject({ playerId: 'u1', status: 'pending', activationLabel: 'Fireball', shortfalls: SHORT });
    const sent = (socket: any) => socket.ws.send.mock.calls.map((call: any[]) => JSON.parse(call[0]));
    expect(sent(gm)[0]).toMatchObject({ type: 'cost:update', request: { playerName: 'Alice', characterName: 'Aria' } });
    expect(sent(player)[0].request).not.toHaveProperty('playerName');
    expect(sent(other)).toEqual([]);
    expect((await ask()).status).toBe(409); // already pending
  });

  it('answers 409 no_dm with nobody to ask, and 409 dm_self when the actor is the DM', async () => {
    room(false);
    const noDm = await ask();
    expect(noDm.status).toBe(409);
    expect(await noDm.json()).toMatchObject({ error: 'no_dm', mode: 'no_dm' });
    sessions.clear();
    room(true);
    accessMock.mockResolvedValue({ canAct: true, isCampaignDm: true });
    expect(await (await ask()).json()).toMatchObject({ error: 'dm_self' });
  });

  it('says notNeeded when it is affordable now, and refuses a character that is not yours or a bad activation', async () => {
    const { session } = room();
    previewMock.mockResolvedValue({ lines: [], shortfalls: [], label: 'Fireball' });
    expect(await (await ask()).json()).toEqual({ notNeeded: true });
    expect(session.costRequests[CHAR]).toBeUndefined();
    accessMock.mockResolvedValue(null);
    expect((await ask()).status).toBe(404);
    accessMock.mockResolvedValue({ canAct: false });
    expect((await ask()).status).toBe(404);
    accessMock.mockResolvedValue({ canAct: true, isCampaignDm: false });
    expect((await ask({ activation: { kind: 'spell', instanceId: 'nope' } })).status).toBe(400);
  });

  it('refuses a room the player is not in', async () => {
    const { session } = room();
    delete session.players.u1;
    expect((await ask()).status).toBe(403);
  });

  it('withdraw removes it and tells the GM, but not while it is being used or for someone else', async () => {
    const { session, gm } = room();
    await ask();
    const request = session.costRequests[CHAR];
    expect((await playerAction({ action: 'withdraw', requestId: request.id }, 'u2')).status).toBe(409);
    expect((await playerAction({ action: 'withdraw', requestId: request.id })).status).toBe(200);
    expect(session.costRequests[CHAR]).toBeUndefined();
    expect(gm.ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0])).pop()).toMatchObject({ type: 'cost:closed', outcome: 'withdrawn' });
    expect((await playerAction({ action: 'withdraw', requestId: request.id })).status).toBe(409);

    await ask();
    const again = session.costRequests[CHAR];
    again.status = 'used';
    expect((await playerAction({ action: 'withdraw', requestId: again.id })).status).toBe(409);
  });
});

describe('GM decisions', () => {
  it('approve and deny are GM-only and need a live request', async () => {
    const { session } = room();
    await ask();
    const id = session.costRequests[CHAR].id;
    expect((await gmAction({ action: 'approve', requestId: id }, 'u1')).status).toBe(403);
    expect((await gmAction({ action: 'approve', requestId: 'stale' })).status).toBe(409);
    expect((await gmAction({ action: 'nope', requestId: id })).status).toBe(400);
  });

  it('approve stamps who and when; a second approve, or a deny after it, is refused', async () => {
    const { session } = room();
    const request = await approvedRequest(session, { waive: true });
    expect(request).toMatchObject({ status: 'approved', approvedBy: 'gm-user', approvedByName: 'Tony', waive: true });
    expect(typeof request.approvedAt).toBe('number');
    expect((await gmAction({ action: 'approve', requestId: request.id })).status).toBe(409);
    expect((await gmAction({ action: 'deny', requestId: request.id })).status).toBe(409);
  });

  it('a busy request blocks a double click', async () => {
    const { session } = room();
    await ask();
    session.costRequests[CHAR].busy = true;
    expect(await (await gmAction({ action: 'approve', requestId: session.costRequests[CHAR].id })).json()).toMatchObject({ error: 'busy' });
  });

  it('deny deletes the request, tells the player, and posts the roll-log line', async () => {
    const { session, player } = room();
    await ask();
    const id = session.costRequests[CHAR].id;
    expect((await gmAction({ action: 'deny', requestId: id })).status).toBe(200);
    expect(session.costRequests[CHAR]).toBeUndefined();
    expect(player.ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0])).pop()).toMatchObject({ type: 'cost:closed', outcome: 'denied' });
    expect(logRollMock).toHaveBeenCalledWith('ROOM', "The DM declined Aria's Fireball.", expect.anything(), 'public');
  });
});

describe('the player view', () => {
  it('mine returns only the caller\'s own request for that character', async () => {
    const { session } = room();
    await ask();
    const own = await (await mine()).json();
    expect(own).toMatchObject({ dmPresent: true, request: { status: 'pending', activationLabel: 'Fireball', characterId: CHAR } });
    expect(own.request).not.toHaveProperty('playerName');
    expect((await (await mine('u2')).json()).request).toBeNull();
    expect((await (await mine('u1', OTHER_CHAR)).json()).request).toBeNull();
    session.costRequests[CHAR].status = 'approved';
    session.costRequests[CHAR].approvedAt = 1000;
    expect((await (await mine()).json()).expiresAt).toBe(1000 + state.APPROVAL_TTL_MS);
  });

  it('mine is 404 for a character you cannot act for', async () => {
    room();
    accessMock.mockResolvedValue({ canAct: false });
    expect((await mine()).status).toBe(404);
  });

  it('filterSessionForRole strips other players\' requests from a player and leaves the GM everything', async () => {
    const { session } = room();
    await ask();
    session.costRequests[OTHER_CHAR] = { ...session.costRequests[CHAR], id: 'x', characterId: OTHER_CHAR, playerId: 'u2', playerName: 'Bob' };
    const asPlayer = filterSessionForRole(session, 'player', 'u1');
    expect(Object.keys(asPlayer.costRequests)).toEqual([CHAR]);
    expect(asPlayer.costRequests[CHAR]).not.toHaveProperty('playerName');
    expect(Object.keys(filterSessionForRole(session, 'player', 'u3').costRequests)).toEqual([]);
    expect(Object.keys(filterSessionForRole(session, 'gm', null).costRequests)).toEqual([CHAR, OTHER_CHAR]);
    session.map = { revealed: false };
    expect(Object.keys(filterSessionForRole(session, 'player', 'u2').costRequests)).toEqual([OTHER_CHAR]);
  });

  it('cost:ping carries no detail and cost:update never reaches a watcher', async () => {
    const { session } = room();
    const watcher = sock('watcher', null);
    watchersByTopic.set('room:ROOM', new Set([watcher]));
    setWatches(watcher as any, ['room:ROOM']);
    await ask();
    const sent = watcher.ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0]));
    expect(sent).toEqual([{ type: 'cost:ping', topic: 'room:ROOM' }]);
    expect(JSON.stringify(sent)).not.toMatch(/Fireball|Vowfire|activation/);
    expect(session.costRequests[CHAR]).toBeDefined();
  });
});

describe('approvalVerdict', () => {
  const base = () => state.newCostRequest({
    characterId: CHAR, characterName: 'Aria', playerId: 'u1', playerName: 'Alice', source: 'vtt', activation: spell, activationLabel: 'Fireball', shortfalls: SHORT
  });
  const input = { userId: 'u1', characterId: CHAR, signature: activationSignature(spell) };

  it('only an approved, matching, fresh approval for the asking player passes', () => {
    const request = base();
    expect(state.approvalVerdict(request, input)).toEqual({ ok: false, reason: 'not_approved' });
    request.status = 'approved';
    request.approvedAt = 1_000_000;
    const now = 1_000_000 + 1000;
    expect(state.approvalVerdict(request, { ...input, now })).toEqual({ ok: true });
    expect(state.approvalVerdict(request, { ...input, now, characterId: OTHER_CHAR })).toEqual({ ok: false, reason: 'wrong_character' });
    expect(state.approvalVerdict(request, { ...input, now, userId: 'u2' })).toEqual({ ok: false, reason: 'not_yours' });
    expect(state.approvalVerdict(request, { ...input, now, signature: activationSignature({ ...spell, slotLevel: 3 }) })).toEqual({ ok: false, reason: 'wrong_activation' });
    expect(state.approvalVerdict(request, { ...input, now: 1_000_000 + state.APPROVAL_TTL_MS })).toEqual({ ok: true });
    expect(state.approvalVerdict(request, { ...input, now: 1_000_000 + state.APPROVAL_TTL_MS + 1 })).toEqual({ ok: false, reason: 'expired' });
  });

  it('claiming is single-use and a failed use can be released', () => {
    const request = base();
    request.status = 'approved';
    request.approvedAt = Date.now();
    state.claimApproval(request);
    expect(state.approvalVerdict(request, input)).toEqual({ ok: false, reason: 'not_approved' });
    state.releaseApproval(request);
    expect(state.approvalVerdict(request, input)).toEqual({ ok: true });
  });
});

describe('the cost gate', () => {
  const gate = (extra: Record<string, unknown> = {}) => openCostGate({ userId: 'u1', characterId: CHAR, activation: spell, roomId: 'ROOM', ...extra });

  it('with no override asked, there is none, and the mode says which prompt to show', async () => {
    room(true);
    const g: any = await gate();
    expect(g).toMatchObject({ ok: true, override: null, mode: 'ask_dm' });
    sessions.clear();
    room(false);
    expect(((await gate()) as any).mode).toBe('no_dm');
    accessMock.mockResolvedValue({ canAct: true, isCampaignDm: true });
    expect(((await gate()) as any).mode).toBe('dm_self');
    const body = costShortfallBody(g, new (CostShortfallError as any)(SHORT));
    expect(body).toMatchObject({ error: 'insufficient', mode: 'ask_dm', shortfalls: SHORT, activation: spell });
  });

  it('override self is refused (left to fail as ask_dm) while a DM is present, and granted with none', async () => {
    room(true);
    expect(await gate({ override: 'self' })).toMatchObject({ ok: true, override: null, mode: 'ask_dm' });
    sessions.clear();
    room(false);
    expect(await gate({ override: 'self' })).toMatchObject({ ok: true, override: { kind: 'self_override', roomId: 'ROOM' } });
  });

  it('override dm is 403 for a non-DM, and granted for a campaign DM or the room GM', async () => {
    room(true);
    const refused: any = await gate({ override: 'dm' });
    expect(refused).toMatchObject({ ok: false, status: 403 });
    accessMock.mockResolvedValue({ canAct: true, isCampaignDm: true });
    expect(await gate({ override: 'dm' })).toMatchObject({ ok: true, override: { kind: 'dm_self' } });
    // The room GM who isn't a campaign member (a Quick room) counts too.
    accessMock.mockResolvedValue({ canAct: true, isCampaignDm: false });
    expect(await openCostGate({ userId: 'gm-user', characterId: CHAR, activation: spell, override: 'dm', roomId: 'ROOM' })).toMatchObject({ ok: true, override: { kind: 'dm_self' } });
    // A site admin who is neither is not a DM (access has canAct false for them, isCampaignDm false).
    accessMock.mockResolvedValue({ canAct: false, isCampaignDm: false, viaAdmin: true });
    expect(await openCostGate({ userId: 'admin', characterId: CHAR, activation: spell, override: 'dm', roomId: 'ROOM' })).toMatchObject({ ok: false, status: 403 });
  });

  it('an approval is single-use, bound to the activation, and expires', async () => {
    const { session } = room();
    const request = await approvedRequest(session);

    const wrong: any = await gate({ approvalId: request.id, activation: { ...spell, slotLevel: 3 } });
    expect(wrong).toMatchObject({ ok: false, status: 409, body: { error: 'approval_invalid', reason: 'wrong_activation' } });

    const good: any = await gate({ approvalId: request.id });
    expect(good).toMatchObject({ ok: true, override: { kind: 'dm_approved', approvedByUserId: 'gm-user', approvalRequestId: request.id, waive: false } });
    // Claimed: a second use is refused while the first runs.
    expect(await gate({ approvalId: request.id })).toMatchObject({ ok: false, body: { reason: 'not_approved' } });

    // The activation failed for another reason: the approval is back.
    await good.settle(false);
    const retry: any = await gate({ approvalId: request.id });
    expect(retry.ok).toBe(true);
    // It paid: the request is gone and the GM and player are told it was used.
    await retry.settle(true);
    expect(session.costRequests[CHAR]).toBeUndefined();
    expect(await gate({ approvalId: request.id })).toMatchObject({ ok: false, body: { reason: 'not_found' } });
  });

  it('an expired approval is refused and cleared', async () => {
    const { session } = room();
    const request = await approvedRequest(session);
    request.approvedAt = Date.now() - state.APPROVAL_TTL_MS - 1000;
    expect(await gate({ approvalId: request.id })).toMatchObject({ ok: false, body: { reason: 'expired' } });
    expect(session.costRequests[CHAR]).toBeUndefined();
  });

  it('another player cannot use someone else\'s approval', async () => {
    const { session } = room();
    const request = await approvedRequest(session);
    session.players.u2 = { id: 'u2', name: 'Bob' };
    expect(await openCostGate({ userId: 'u2', characterId: CHAR, activation: spell, approvalId: request.id, roomId: 'ROOM' })).toMatchObject({ ok: false, body: { reason: 'not_yours' } });
  });

  it('posts the roll-log line only when an override really let a short activation through', async () => {
    const { session } = room();
    const request = await approvedRequest(session);
    const g: any = await gate({ approvalId: request.id });
    await runWithGate(g, async (override) => { override?.onUsed?.({ kind: 'dm_approved', label: 'Fireball', shortfalls: SHORT, waived: false }); });
    expect(logRollMock).toHaveBeenCalledWith(
      'ROOM', 'Aria cast Fireball over budget (short 1 Vowfire) - approved by Tony.', expect.objectContaining({ overrideKind: 'dm_approved' }), 'public'
    );
    expect(session.costRequests[CHAR]).toBeUndefined();

    logRollMock.mockClear();
    const affordable: any = await gate();
    await runWithGate(affordable, async () => {});
    expect(logRollMock).not.toHaveBeenCalled();
  });

  it('a self override logs for review and ends a request still waiting', async () => {
    const { session } = room(true);
    await ask();
    session.gmSocketId = 'gm-user';
    for (const socket of socketsBySession.get('ROOM')!) if ((socket as any).role === 'gm') (socket as any).ws.readyState = 3; // the DM leaves
    const g: any = await gate({ override: 'self' });
    expect(g.override.kind).toBe('self_override');
    await runWithGate(g, async (override) => { override?.onUsed?.({ kind: 'self_override', label: 'Fireball', shortfalls: SHORT, waived: false }); });
    expect(session.costRequests[CHAR]).toBeUndefined();
    expect(logRollMock).toHaveBeenCalledWith('ROOM', expect.stringContaining("the player says the DM OK'd it"), expect.anything(), 'public');
  });

  it('a failed run releases the approval and rethrows', async () => {
    const { session } = room();
    const request = await approvedRequest(session);
    const g: any = await gate({ approvalId: request.id });
    await expect(runWithGate(g, async () => { throw new Error('Spell must be known and prepared before casting.'); })).rejects.toThrow('prepared');
    expect(session.costRequests[CHAR].status).toBe('approved');
  });
});

/** A Quick room (no campaign) where 'u1' joined as GM: anyone can make one of these. */
function quickRoomWithFakeGm(userId = 'u1') {
  const session: any = createSession('QUICK');
  session.gmSocketId = userId;
  session.players = { [userId]: { id: userId, name: 'Mallory' } };
  sessions.set('QUICK', session);
  socketsBySession.set('QUICK', new Set([sock('gm', null, { gmUserId: userId })]));
  return session;
}

describe('a Quick-room fake DM', () => {
  it('cannot use override dm or ask for a campaign character, by roomId or by active room', async () => {
    const { session } = room(true); // the campaign's real table, real DM live
    quickRoomWithFakeGm();
    const gate = (extra: Record<string, unknown>) => openCostGate({ userId: 'u1', characterId: CHAR, activation: spell, ...extra });
    expect(await gate({ override: 'dm', roomId: 'QUICK' })).toMatchObject({ ok: false, status: 403, body: { error: 'wrong_room' } });
    // Active room is the Quick room and no roomId: the campaign's own room is used, where u1 is no GM.
    queryMock.mockResolvedValue({ rows: [{ name: 'Aria', campaign_id: 'camp1', room_code: 'ROOM', active_vtt_session_id: 'QUICK' }], rowCount: 1 });
    expect(await gate({ override: 'dm' })).toMatchObject({ ok: false, status: 403, body: { error: 'forbidden' } });
    expect(await gate({ override: 'self' })).toMatchObject({ ok: true, override: null, mode: 'ask_dm' });
    // ask: by roomId it is refused, and without one it goes to the REAL room, never "you are the DM".
    expect((await ask({ roomId: 'QUICK' })).status).toBe(403);
    const asked = await ask({ roomId: undefined });
    expect(asked.status).toBe(200);
    expect(session.costRequests[CHAR]).toBeDefined();
  });

  it('with the campaign room empty it is no_dm for them, not dm_self', async () => {
    quickRoomWithFakeGm();
    queryMock.mockResolvedValue({ rows: [{ name: 'Aria', campaign_id: 'camp1', room_code: 'ROOM', active_vtt_session_id: 'QUICK' }], rowCount: 1 });
    expect(await (await ask({ roomId: undefined })).json()).toMatchObject({ error: 'no_dm' });
  });

  it('a Quick-room GM is still the DM for a character with no campaign', async () => {
    quickRoomWithFakeGm();
    queryMock.mockResolvedValue({ rows: [{ name: 'Aria', campaign_id: null, room_code: null, active_vtt_session_id: 'QUICK' }], rowCount: 1 });
    expect(await openCostGate({ userId: 'u1', characterId: CHAR, activation: spell, override: 'dm', roomId: 'QUICK' })).toMatchObject({ ok: true, override: { kind: 'dm_self' } });
  });
});

describe('the campaign table decides whether a DM is present', () => {
  it('the sheet path cannot self-override while the DM is live in the campaign room', async () => {
    room(true);
    const quick: any = createSession('QUICK');
    sessions.set('QUICK', quick);
    queryMock.mockResolvedValue({ rows: [{ name: 'Aria', campaign_id: 'camp1', room_code: 'ROOM', active_vtt_session_id: 'QUICK' }], rowCount: 1 });
    // No roomId (the sheet), the player's active room is a Quick room with no DM: still ask_dm.
    expect(await openCostGate({ userId: 'u1', characterId: CHAR, activation: spell, override: 'self' })).toMatchObject({ ok: true, override: null, mode: 'ask_dm' });
    // The campaign room's DM leaves: now it is the no-DM path.
    sessions.clear();
    room(false);
    expect(await openCostGate({ userId: 'u1', characterId: CHAR, activation: spell, override: 'self' })).toMatchObject({ ok: true, override: { kind: 'self_override', roomId: 'ROOM' } });
  });
});

describe('sweeping stale requests', () => {
  it('an approved request past its window is closed as expired when someone asks, and the ask carries on', async () => {
    const { session, player } = room();
    const old = await approvedRequest(session);
    old.approvedAt = Date.now() - state.APPROVAL_TTL_MS - 1000;
    expect((await ask()).status).toBe(200);
    const fresh = session.costRequests[CHAR];
    expect(fresh.id).not.toBe(old.id);
    expect(fresh.status).toBe('pending');
    expect(player.ws.send.mock.calls.map((c: any[]) => JSON.parse(c[0])).some((m: any) => m.type === 'cost:closed' && m.outcome === 'expired')).toBe(true);
  });

  it('a waiting request whose requester can no longer act for the character is dropped', async () => {
    const { session } = room();
    await ask();
    const old = session.costRequests[CHAR];
    old.playerId = 'u3';
    accessMock.mockImplementation(async (_db: unknown, userId: string) => (userId === 'u3' ? { canAct: false, isCampaignDm: false } : { canAct: true, isCampaignDm: false }));
    expect((await ask()).status).toBe(200);
    expect(session.costRequests[CHAR].id).not.toBe(old.id);
    expect(session.costRequests[CHAR].playerId).toBe('u1');
  });
});

describe('helpers', () => {
  it('parses activations and builds the cast form activation the same way', () => {
    expect(state.parseActivation({ kind: 'spell', instanceId: INSTANCE, slotType: 'pact', slotLevel: 3 })).toEqual({ kind: 'spell', instanceId: INSTANCE, slotType: 'pact', slotLevel: 3 });
    expect(state.parseActivation({ kind: 'spell', instanceId: INSTANCE, slotType: 'junk', slotLevel: 12 })).toEqual({ kind: 'spell', instanceId: INSTANCE });
    expect(state.parseActivation({ kind: 'item', inventoryId: 'x' })).toBeNull();
    expect(state.parseActivation(null)).toBeNull();
    // Weapon attacks (a real weapon, or an id-less one named by a label) and dashes.
    expect(state.parseActivation({ kind: 'weapon_attack', inventoryId: INSTANCE })).toEqual({ kind: 'weapon_attack', inventoryId: INSTANCE });
    expect(state.parseActivation({ kind: 'weapon_attack', inventoryId: INSTANCE, timing: 'reaction', label: 'ignored' })).toEqual({ kind: 'weapon_attack', inventoryId: INSTANCE, timing: 'reaction' });
    expect(state.parseActivation({ kind: 'weapon_attack', inventoryId: null, label: ' Unarmed Strike ', timing: 'bonus_action' })).toEqual({ kind: 'weapon_attack', inventoryId: null, label: 'Unarmed Strike', timing: 'bonus_action' });
    for (const bad of [
      { kind: 'weapon_attack', inventoryId: 'nope' }, { kind: 'weapon_attack', inventoryId: null }, { kind: 'weapon_attack', inventoryId: null, label: '   ' },
      { kind: 'weapon_attack', inventoryId: null, label: 'x'.repeat(81) }, { kind: 'weapon_attack', inventoryId: null, label: 5 },
      { kind: 'weapon_attack', inventoryId: INSTANCE, timing: 'free' }, { kind: 'weapon_attack', inventoryId: INSTANCE, timing: 'movement' }
    ]) expect(state.parseActivation(bad), JSON.stringify(bad)).toBeNull();
    expect(state.parseActivation({ kind: 'dash', count: 3 })).toEqual({ kind: 'dash', count: 3 });
    // The explicit follow-up choice (Extra Attack repeat / spell echo), on weapons, spells and granted spells.
    expect(state.parseActivation({ kind: 'weapon_attack', inventoryId: INSTANCE, followup: 'skip' })).toEqual({ kind: 'weapon_attack', inventoryId: INSTANCE, followup: 'skip' });
    expect(state.parseActivation({ kind: 'spell', instanceId: INSTANCE, followup: 'use' })).toEqual({ kind: 'spell', instanceId: INSTANCE, followup: 'use' });
    expect(state.parseActivation({ kind: 'spell_access', spellAccessId: INSTANCE, inventoryItemId: INSTANCE, followup: 'use' })).toMatchObject({ followup: 'use' });
    expect(state.parseActivation({ kind: 'spell', instanceId: INSTANCE })).toEqual({ kind: 'spell', instanceId: INSTANCE });
    for (const followup of ['maybe', 1, null, true]) expect(state.parseActivation({ kind: 'spell', instanceId: INSTANCE, followup })).toBeNull();
    const echoForm = new FormData();
    echoForm.set('instanceId', INSTANCE);
    echoForm.set('followup', 'use');
    expect(state.activationFromCastForm(echoForm)).toEqual({ kind: 'spell', instanceId: INSTANCE, followup: 'use' });
    echoForm.set('followup', 'whatever');
    expect(state.activationFromCastForm(echoForm)).toEqual({ kind: 'spell', instanceId: INSTANCE });
    for (const count of [0, 10, 1.5, '2', null, undefined]) expect(state.parseActivation({ kind: 'dash', count })).toBeNull();
    const form = new FormData();
    form.set('instanceId', INSTANCE);
    form.set('slotType', 'standard');
    form.set('slotLevel', '2');
    expect(state.activationFromCastForm(form)).toEqual(spell);
  });

  it('words the log lines', () => {
    expect(state.shortfallText([{ label: 'Vowfire', needed: 2, available: 0 }, { label: 'Level 3 Spell Slot', needed: 1, available: 0 }])).toBe('2 Vowfire, 1 Level 3 Spell Slot');
    const common = { characterName: 'Aria', label: 'Fireball', activation: spell, shortfalls: SHORT, waived: false };
    expect(state.overrideLogMessage({ ...common, kind: 'dm_self' })).toBe("Aria cast Fireball over budget (short 1 Vowfire) - the DM's call.");
    expect(state.overrideLogMessage({ ...common, kind: 'dm_approved', approvedByName: 'Tony', waived: true })).toContain('approved by Tony, spending nothing');
    expect(state.overrideLogMessage({ ...common, kind: 'self_override', activation: { kind: 'item', inventoryId: 'i' } })).toContain('Aria used Fireball');
    expect(state.overrideLogMessage({ ...common, label: 'Longsword attack', kind: 'dm_self', activation: { kind: 'weapon_attack', inventoryId: null, label: 'Longsword' } })).toContain('Aria attacked with Longsword over budget');
    expect(state.overrideLogMessage({ ...common, label: 'Dash', kind: 'dm_self', activation: { kind: 'dash', count: 1 } })).toContain('Aria dashed over budget');
  });
});
