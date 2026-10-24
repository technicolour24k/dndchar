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
    };
  }
  return globalThis[GLOBAL_KEY];
}

export const sessions = getGlobalStore().sessions;
export const socketsBySession = getGlobalStore().socketsBySession;
export const watchersByTopic = getGlobalStore().watchersByTopic;

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

export function createSession(id) {
  return {
    id,
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
    return { ...session, map: { revealed: false }, tokens: {}, markers: {} };
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

  return { ...session, tokens, markers };
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
