// @ts-nocheck - plain untyped JS by design (see vtt/README.md); shared as-is
// between the SvelteKit route bundle, the Vite dev plugin, and server.js.
import crypto from 'node:crypto';

// Excludes 0/O/1/I to avoid ambiguity when a room code is read aloud/typed.
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

// This module is reachable from two different loading paths in the same
// process: directly (vite.config.ts's dev plugin / server.js in prod) and
// indirectly via SvelteKit's bundled `+server.ts` routes (through the $vtt
// alias). Those two paths aren't guaranteed to resolve to the same module
// instance, so the actual state lives on `globalThis` - both paths end up
// pointing at the same Maps regardless of how many times this file's top
// level runs.
const GLOBAL_KEY = '__vttStore__';

function getGlobalStore() {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = {
      sessions: new Map(),
      socketsBySession: new Map(),
      // db-traffic-reduction Phase 5: a "watcher" is a sheet (or Session Notes
      // modal) tab that subscribed to a topic via {type:'watch'} - it never
      // joins a VTT session (no 'join' message, no role/playerId), it just
      // wants a narrow slice of events pushed to it. Keyed by topic string
      // ("room:<sessionId>" or "game-session:<gameSessionId>"), value is the
      // Set of watcher `meta` objects currently watching that topic.
      watchersByTopic: new Map(),
      // Campaign rooms: short-lived single-use join tickets, keyed by token. Written by the
      // SvelteKit ticket route (which has the cookie session and the DB), consumed by join.js.
      joinTickets: new Map(),
      // Extra per-socket clean-up registered by the ws layer (name -> fn(meta, session)), run by
      // releaseSocket. On the global store so every module instance sees the same hooks.
      releaseHooks: new Map(),
      // Overworld live route preview (Unit G): one-use tickets and the sockets joined per map.
      overworldLiveTickets: new Map(),
      overworldLiveByMap: new Map(),
    };
  }
  // A store created before tickets existed (a long-running dev process after HMR) lacks the map.
  globalThis[GLOBAL_KEY].joinTickets ??= new Map();
  globalThis[GLOBAL_KEY].releaseHooks ??= new Map();
  globalThis[GLOBAL_KEY].overworldLiveTickets ??= new Map();
  globalThis[GLOBAL_KEY].overworldLiveByMap ??= new Map();
  return globalThis[GLOBAL_KEY];
}

export const sessions = getGlobalStore().sessions;
export const socketsBySession = getGlobalStore().socketsBySession;
export const watchersByTopic = getGlobalStore().watchersByTopic;
export const joinTickets = getGlobalStore().joinTickets;
const releaseHooks = getGlobalStore().releaseHooks;
const overworldLiveTickets = getGlobalStore().overworldLiveTickets;
const overworldLiveByMap = getGlobalStore().overworldLiveByMap;

const MAX_WATCH_TOPICS = 10;

// Replaces whatever topics `meta` was previously watching with `topics`
// (capped defensively - the protocol-level cap/validation lives in
// wsServer.js's 'watch' handler, this is just a second safety net). Called
// on every {type:'watch'} message, including a re-subscribe with an updated
// list from the same socket.
export function setWatches(meta, topics) {
  removeWatcher(meta);
  meta.watchTopics = new Set(topics.slice(0, MAX_WATCH_TOPICS));
  for (const topic of meta.watchTopics) {
    let watchers = watchersByTopic.get(topic);
    if (!watchers) {
      watchers = new Set();
      watchersByTopic.set(topic, watchers);
    }
    watchers.add(meta);
  }
}

// Removes `meta` from every topic it's currently watching - called on a
// re-subscribe (via setWatches above) and on socket close.
export function removeWatcher(meta) {
  if (!meta.watchTopics) return;
  for (const topic of meta.watchTopics) {
    const watchers = watchersByTopic.get(topic);
    if (!watchers) continue;
    watchers.delete(meta);
    if (watchers.size === 0) watchersByTopic.delete(topic);
  }
  meta.watchTopics = new Set();
}

// Sends payload (plus the topic it came from, so a client with several
// subscriptions open on one socket can route it) to every watcher of `topic`.
export function publish(topic, payload) {
  const watchers = watchersByTopic.get(topic);
  if (!watchers) return;
  const message = JSON.stringify({ ...payload, topic });
  for (const meta of watchers) {
    if (meta.ws.readyState === meta.ws.OPEN) meta.ws.send(message);
  }
}

// Narrow allow-list of broadcast() types that are safe and useful to forward
// to sheet watchers: state changes and append-only log lines, never raw VTT
// token/map/marker data (that stays participant-only, see filterSessionForRole).
// NEVER add forage:update, forage:closed or forage:ping here. Watch subscriptions are
// unauthenticated, and forage payloads carry a player's private view (the DM's loot preview, the
// finder's check). forage:ping is sent with publish() directly because it carries no details.
const WATCHABLE_BROADCAST_TYPES = new Set(['combat:state', 'combat:log', 'roll:log', 'game_session:state']);

export function generateRoomCode(existingSessions) {
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
      code += ROOM_CODE_CHARS[crypto.randomInt(ROOM_CODE_CHARS.length)];
    }
  } while (existingSessions.has(code));
  return code;
}

export function createSession(id, options = {}) {
  return {
    id,
    // Set for a campaign's table (its fixed room code), null for a Quick room. A campaign room
    // only accepts ticketed joins (see handlers/join.js).
    campaignId: options.campaignId ?? null,
    gmSocketId: null,
    map: null,
    tokens: {},
    players: {},
    markers: {},
    // Set by POST /vtt/api/session/[id]/combat ("Start Combat"), cleared by the
    // same route's "Stop Combat" - the DB-backed `encounters.id` that attack/
    // spell resolution (token.js) logs against. null means combat hasn't been
    // started, so damage resolution skips combat-log writes entirely.
    encounterId: null,
    // Set by POST /vtt/api/session/[id]/game-session ("Start Session"), cleared
    // by its "End Session" - the DB-backed `game_sessions.id` that Session Notes
    // posted from any surface get live-pushed to (see gameSessions.ts's
    // broadcastToMatchingSession). Independent of encounterId/combat state -
    // notes are meant to span a whole game night, not just fights.
    gameSessionId: null,
    // Forage (DM mode only), written only by the forage endpoints. In memory by design: a restart
    // wipes the room, so a pending request simply ends. forage is keyed by the finder's user id
    // (the in-flight request, GM sees all of it), forageResults by the same id (the last closed
    // result, so a finder who wasn't watching still sees it). Self-serve finds live in the DB.
    forage: {},
    forageResults: {},
  };
}

// ---------------------------------------------------------------------------------------------
// Campaign rooms: join tickets and room lifecycle
// ---------------------------------------------------------------------------------------------

const JOIN_TICKET_TTL_MS = 60 * 1000;

// Issued by the SvelteKit ticket route after it has checked the user's real campaign membership.
// join.js takes identity, role and GM-seat rights from the ticket and ignores what the client
// sends. `seat` is the GM-seat rank: 'primary' (the primary DM), 'co' (the co-DM) or null (a
// player ticket, which can never become GM). `takeoverOf` is the takeover the client is asking for:
// 'self' (replace the asker's OWN older GM socket) or 'co' (the primary DM replacing the co-DM).
// join.js applies it only if it matches who actually holds the seat at join time, so a stale
// intent (the seat changed hands since the client was told) can't displace somebody else.
// Sweeps expired tickets on each issue so abandoned ones can't pile up.
/** @param {{ sessionId: string, userId: string, displayName: string, role: string, seat?: string | null, takeoverOf?: 'self' | 'co' | null }} ticket */
export function issueJoinTicket({ sessionId, userId, displayName, role, seat = null, takeoverOf = null }) {
  const now = Date.now();
  for (const [token, ticket] of joinTickets) {
    if (ticket.expiresAt <= now) joinTickets.delete(token);
  }
  const token = crypto.randomBytes(24).toString('base64url');
  joinTickets.set(token, {
    sessionId,
    userId,
    displayName,
    role: role === 'gm' ? 'gm' : 'player',
    seat: role === 'gm' ? seat : null,
    takeoverOf: role === 'gm' && (takeoverOf === 'self' || takeoverOf === 'co') ? takeoverOf : null,
    expiresAt: now + JOIN_TICKET_TTL_MS,
  });
  return token;
}

// Single use: the ticket is deleted whether or not it turns out to be expired.
export function consumeJoinTicket(token) {
  if (typeof token !== 'string') return null;
  const ticket = joinTickets.get(token);
  if (!ticket) return null;
  joinTickets.delete(token);
  return ticket.expiresAt > Date.now() ? ticket : null;
}

// Revoking: a ticket issued a moment before a member was removed (or the campaign archived) must
// not let them straight back in. Called from the kick helpers' callers (campaignRooms.ts) BEFORE
// the sockets are kicked.
export function revokeJoinTickets(sessionId, userId) {
  for (const [token, ticket] of joinTickets) {
    if (ticket.sessionId === sessionId && ticket.userId === userId) joinTickets.delete(token);
  }
}

// GM tickets whose seat no longer matches the holder's current role (a primary/co-DM swap or an
// admin "make primary" happened after the ticket was issued). `seatByUser` maps user id ->
// 'primary' | 'co' for the room's current DMs; a GM ticket for anyone else is revoked too.
export function revokeStaleGmTickets(sessionId, seatByUser) {
  for (const [token, ticket] of joinTickets) {
    if (ticket.sessionId !== sessionId || ticket.role !== 'gm') continue;
    if (seatByUser.get(ticket.userId) !== ticket.seat) joinTickets.delete(token);
  }
}

// Every outstanding ticket for the room (used when the campaign is archived).
export function revokeRoomTickets(sessionId) {
  for (const [token, ticket] of joinTickets) {
    if (ticket.sessionId === sessionId) joinTickets.delete(token);
  }
}

// The live in-memory room for a campaign's fixed room code, created empty if it's missing (a
// restart wipes rooms, the next open recreates it). An existing room keeps its state. Refuses to
// hand back a room that belongs to a different campaign rather than mix two tables together.
export function ensureRoom(roomCode, campaignId) {
  let session = sessions.get(roomCode);
  if (!session) {
    session = createSession(roomCode, { campaignId });
    sessions.set(roomCode, session);
  } else if (session.campaignId !== campaignId) {
    throw new Error(`Room ${roomCode} already exists and belongs to a different campaign.`);
  }
  if (!socketsBySession.has(roomCode)) socketsBySession.set(roomCode, new Set());
  return session;
}

// Kicks every socket in the room that belongs to this user (as a player or as the GM): the client
// is told why, then the socket is closed with 4001. A no-op if the room isn't live.
export function disconnectUserFromRoom(sessionId, userId, reason) {
  const sockets = socketsBySession.get(sessionId);
  if (!sockets || !userId) return;
  for (const meta of [...sockets]) {
    // meta.userId is the ticket's user id (campaign rooms); playerId / gmUserId are the fallback
    // for sockets that joined without a ticket.
    if (meta.userId !== userId && meta.playerId !== userId && meta.gmUserId !== userId) continue;
    kickSocket(meta, reason);
  }
}

// Kicks everyone in the room (used when a campaign is archived).
export function disconnectAllFromRoom(sessionId, reason) {
  const sockets = socketsBySession.get(sessionId);
  if (!sockets) return;
  for (const meta of [...sockets]) kickSocket(meta, reason);
}

// Tells the client why, closes the socket, and releases its room membership right away (seat,
// player entry, set membership) instead of waiting for the close event, so a kicked GM stops being
// the seat holder immediately. meta.sessionId is cleared by releaseSocket, so the later close
// event finds nothing left to do.
function kickSocket(meta, reason) {
  if (meta.ws.readyState === meta.ws.OPEN) {
    meta.ws.send(JSON.stringify({ type: 'kicked', reason }));
    meta.ws.close(4001);
  }
  releaseSocket(meta);
}

export function registerReleaseHook(name, fn) {
  releaseHooks.set(name, fn);
}

// Everything that has to happen when a socket stops being in its room: it closed, it was kicked,
// or it is hopping to another room. Safe to call twice (the second call finds sessionId null).
export function releaseSocket(meta) {
  const sessionId = meta.sessionId;
  if (!sessionId) return;
  const sockets = socketsBySession.get(sessionId);
  if (sockets) sockets.delete(meta);
  const session = sessions.get(sessionId);
  if (session) {
    for (const hook of releaseHooks.values()) hook(meta, session);
    if (meta.role === 'player' && meta.playerId && session.players[meta.playerId]) {
      // Don't delete the player outright - they should reappear correctly on reconnect via the
      // same state:full path join.js already uses.
      session.players[meta.playerId].connected = false;
      const playerId = meta.playerId;
      broadcast(sessionId, () => ({ type: 'player:left', playerId }));
    } else if (meta.role === 'gm' && meta.gmUserId && session.gmSocketId === meta.gmUserId && !findLiveGmSocket(sockets)) {
      // Clears for account GMs too (gmSocketId is their user id, remembered on the socket as
      // meta.gmUserId; meta.playerId is null for every GM). Skipped when another live GM socket
      // exists, so a late release of an old socket can't unseat a reconnected or replacing GM.
      session.gmSocketId = null;
    }
  }
  meta.sessionId = null;
  meta.role = null;
  meta.userId = null;
  meta.gmUserId = null;
  meta.gmSeat = null;
}

// After a membership change: updates the GM-seat rank on a user's live GM socket(s) in the room so
// it matches their new role ('primary' for the primary DM, 'co' for the co-DM).
export function setGmSeat(sessionId, userId, seat) {
  const sockets = socketsBySession.get(sessionId);
  if (!sockets) return;
  for (const meta of sockets) {
    if (meta.role === 'gm' && meta.gmUserId === userId) meta.gmSeat = seat;
  }
}

// A live GM socket for this session, if one is currently connected - used to tell "GM
// disconnected, gmSocketId is just stale" apart from "GM is still here".
export function findLiveGmSocket(sockets) {
  if (!sockets) return null;
  for (const entry of sockets) {
    if (entry.role === 'gm' && entry.ws.readyState === entry.ws.OPEN) return entry;
  }
  return null;
}

// The real "is a GM here right now" check (gmSocketId is not enough: it holds a player id).
export function hasLiveGm(sessionId) {
  return !!findLiveGmSocket(socketsBySession.get(sessionId));
}

// Forage runs in DM mode only when a GM socket is live AND that GM joined through the app's VTT
// link, so gmSocketId is a real account user id. The 'gm' placeholder (a GM who opened the VTT
// directly) has no account, so they could never act on a request.
export function dmPresent(session) {
  return hasLiveGm(session.id) && !!session.gmSocketId && session.gmSocketId !== 'gm';
}

// What the finder may see of their own request. Never the choice, the loot preview or the table.
export function forageViewForPlayer(request) {
  return { id: request.id, stage: request.stage, source: request.source, check: request.check };
}

// For a non-GM recipient: only their own forage entries survive.
function ownForage(session, playerId) {
  const request = playerId ? session.forage?.[playerId] : undefined;
  const result = playerId ? session.forageResults?.[playerId] : undefined;
  return {
    forage: request ? { [playerId]: forageViewForPlayer(request) } : {},
    forageResults: result ? { [playerId]: result } : {},
  };
}

// Strips secret info from a single token for a player-role recipient.
// Enemy/npc tokens never expose real stats *or their true AC* to players -
// only the GM-set coarse `condition` field, if present, and the separately
// tracked `knownAc` (the lowest attack roll that has actually hit this token -
// an upper bound players discover through play, never the real AC). PC tokens
// are untouched (HP/AC aren't secret between allies).
export function filterTokenForPlayer(token) {
  if (token.type === 'enemy' || token.type === 'npc') {
    const { stats, ac, ...rest } = token;
    if (token.condition !== undefined) rest.condition = token.condition;
    return rest;
  }
  return token;
}

// A marker (AOE/point-on-map) is visible to a player if they placed it
// themselves or the GM has flipped its "visible to all" toggle - otherwise
// it's private to its owner + the GM, same shape as the hidden-token rule.
export function shouldPlayerSeeMarker(marker, playerId) {
  return marker.visibleToAll || marker.ownerId === playerId;
}

// Canonical filter used both for state:full on join and for filtering any
// broadcast that includes token/marker data. GM always gets the unfiltered
// session; playerId is required to resolve per-player marker ownership.
export function filterSessionForRole(session, role, playerId) {
  if (role === 'gm') return session;

  // Phase 10: a GM-hidden map is a hard gate ahead of all other filtering -
  // players get nothing map-related (no image/video, no tokens, no markers)
  // regardless of any individual token/marker's own visibility, since there's
  // nothing to render it onto. `{ revealed: false }` (not `null`) so the
  // client can distinguish "no map set yet" from "map set but not revealed"
  // and show an accurate waiting message (see render() in main.js).
  if (session.map && !session.map.revealed) {
    return { ...session, map: { revealed: false }, tokens: {}, markers: {}, ...ownForage(session, playerId) };
  }

  const tokens = {};
  for (const [id, token] of Object.entries(session.tokens)) {
    if (token.hidden) continue;
    tokens[id] = filterTokenForPlayer(token);
  }

  const markers = {};
  for (const [id, marker] of Object.entries(session.markers || {})) {
    if (shouldPlayerSeeMarker(marker, playerId)) markers[id] = marker;
  }

  return { ...session, tokens, markers, ...ownForage(session, playerId) };
}

// Sends a per-recipient payload to every socket in a session. buildPayload
// returns null to skip a given recipient (used for GM-only/hidden-token data).
//
// Also forwards a narrow allow-list of types (WATCHABLE_BROADCAST_TYPES) to
// any sheet watching "room:<sessionId>" (db-traffic-reduction Phase 5), built
// with a synthetic { role: 'watcher', playerId: null } recipient - every
// buildPayload lambda in this codebase only ever reads recipient.role/
// recipient.playerId (never recipient.ws), so this is safe, and it means a
// GM-only payload (role !== 'gm' check) correctly never reaches a watcher.
// Only computed when something is actually watching that room, to avoid
// paying for it on every single high-frequency token:move-style broadcast.
export function broadcast(sessionId, buildPayload) {
  const sockets = socketsBySession.get(sessionId);
  if (sockets) {
    for (const meta of sockets) {
      const payload = buildPayload(meta);
      if (payload === null || payload === undefined) continue;
      if (meta.ws.readyState === meta.ws.OPEN) {
        meta.ws.send(JSON.stringify(payload));
      }
    }
  }

  const roomTopic = `room:${sessionId}`;
  if (watchersByTopic.get(roomTopic)?.size) {
    const watcherPayload = buildPayload({ role: 'watcher', playerId: null });
    if (watcherPayload && WATCHABLE_BROADCAST_TYPES.has(watcherPayload.type)) {
      publish(roomTopic, watcherPayload);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Overworld live route preview (Unit G)
// ---------------------------------------------------------------------------------------------
// A ticketed per-map channel on this same socket server. The SvelteKit ticket route checks the
// viewer can see the map (campaign role only) and issues a one-use ticket; the socket then joins
// the map's set. Previews are relayed, never stored. The server stamps the drawer's identity from
// the ticket, and a private preview only reaches who could see the saved route (the drawer's own
// sockets and campaign DMs, the same rule as canSeeItem in src/lib/overworld/rules.ts).

const OVERWORLD_LIVE_TICKET_TTL_MS = 60 * 1000;
export const PREVIEW_MIN_GAP_MS = 100; // at most 10 frames/s per socket, extras dropped
export const PREVIEW_IDLE_MS = 30 * 1000; // a preview nobody refreshes for this long clears itself
const MAX_PREVIEW_POINTS = 201;

/** @param {{ campaignId: string, mapId: string, userId: string, displayName: string, isDm: boolean }} t */
export function issueOverworldLiveTicket({ campaignId, mapId, userId, displayName, isDm }) {
  const now = Date.now();
  for (const [token, ticket] of overworldLiveTickets) {
    if (ticket.expiresAt <= now) overworldLiveTickets.delete(token);
  }
  const token = crypto.randomBytes(24).toString('base64url');
  overworldLiveTickets.set(token, { campaignId, mapId, userId, displayName, isDm: !!isDm, expiresAt: now + OVERWORLD_LIVE_TICKET_TTL_MS });
  return token;
}

// Single use, like consumeJoinTicket.
export function consumeOverworldLiveTicket(token) {
  if (typeof token !== 'string') return null;
  const ticket = overworldLiveTickets.get(token);
  if (!ticket) return null;
  overworldLiveTickets.delete(token);
  return ticket.expiresAt > Date.now() ? ticket : null;
}

// Who sees a preview from `sender`: every other socket on the map for 'everyone'; for 'private' only
// the drawer's own other sockets and DMs. `sockets` are metas with a `.live` (see joinOverworldLive).
export function previewRecipients(sender, sockets, visibility) {
  const out = [];
  for (const meta of sockets) {
    if (meta === sender || !meta.live) continue;
    if (visibility === 'everyone' || meta.live.userId === sender.live.userId || meta.live.isDm) out.push(meta);
  }
  return out;
}

function sendTo(metas, payload) {
  const message = JSON.stringify(payload);
  for (const meta of metas) if (meta.ws.readyState === meta.ws.OPEN) meta.ws.send(message);
}

// Takes the ticket's identity onto the socket and files it under its map. Leaves any earlier map first.
export function joinOverworldLive(meta, ticket) {
  leaveOverworldLive(meta);
  meta.live = {
    ...ticket,
    previewId: crypto.randomBytes(6).toString('hex'),
    lastFrameAt: 0,
    visibility: null, // set while a preview is showing
    timer: null,
  };
  let set = overworldLiveByMap.get(ticket.mapId);
  if (!set) overworldLiveByMap.set(ticket.mapId, (set = new Set()));
  set.add(meta);
}

// Stops this socket's preview (if showing) and tells whoever was seeing it.
export function clearOverworldPreview(meta) {
  const live = meta.live;
  if (!live) return;
  clearTimeout(live.timer);
  live.timer = null;
  if (live.visibility === null) return;
  const set = overworldLiveByMap.get(live.mapId);
  if (set) sendTo(previewRecipients(meta, set, live.visibility), { type: 'overworld:preview:clear', previewId: live.previewId });
  live.visibility = null;
}

export function leaveOverworldLive(meta) {
  if (!meta.live) return;
  clearOverworldPreview(meta);
  const set = overworldLiveByMap.get(meta.live.mapId);
  if (set) {
    set.delete(meta);
    if (set.size === 0) overworldLiveByMap.delete(meta.live.mapId);
  }
  meta.live = null;
}

// Validates and relays one preview frame. Malformed frames and frames over the rate limit are
// dropped silently (the client resends the full list anyway, so a drop only costs a few ms).
export function relayOverworldPreview(meta, msg, now = Date.now()) {
  const live = meta.live;
  if (!live) return false;
  const { points, visibility, colour } = msg;
  if (visibility !== 'everyone' && visibility !== 'private') return false;
  if (typeof colour !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(colour)) return false;
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_PREVIEW_POINTS) return false;
  const clean = [];
  for (const p of points) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') return false;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.x < 0 || p.x > 1 || p.y < 0 || p.y > 1) return false;
    clean.push({ x: p.x, y: p.y });
  }
  if (now - live.lastFrameAt < PREVIEW_MIN_GAP_MS) return false;
  live.lastFrameAt = now;
  const set = overworldLiveByMap.get(live.mapId);
  const recipients = set ? previewRecipients(meta, set, visibility) : [];
  // Visibility changed mid-draw: whoever saw the old one but may not see the new one is cleared.
  if (set && live.visibility !== null && live.visibility !== visibility) {
    sendTo(previewRecipients(meta, set, live.visibility).filter((m) => !recipients.includes(m)), { type: 'overworld:preview:clear', previewId: live.previewId });
  }
  live.visibility = visibility;
  clearTimeout(live.timer);
  live.timer = setTimeout(() => clearOverworldPreview(meta), PREVIEW_IDLE_MS);
  live.timer.unref?.();
  if (set) {
    sendTo(recipients, {
      type: 'overworld:preview',
      previewId: live.previewId,
      drawerName: live.displayName,
      points: clean,
      visibility,
      colour,
    });
  }
  return true;
}

// Rights removed: closes preview sockets (4003) matching `filter(meta.live)` and revokes matching
// unspent tickets. Clients that are still allowed just reconnect with a fresh ticket.
export function closeOverworldLive(filter) {
  for (const [token, ticket] of overworldLiveTickets) if (filter(ticket)) overworldLiveTickets.delete(token);
  for (const set of [...overworldLiveByMap.values()]) {
    for (const meta of [...set]) {
      if (!filter(meta.live)) continue;
      leaveOverworldLive(meta);
      meta.ws.close(4003);
    }
  }
}
