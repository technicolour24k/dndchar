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
    };
  }
  return globalThis[GLOBAL_KEY];
}

export const sessions = getGlobalStore().sessions;
export const socketsBySession = getGlobalStore().socketsBySession;

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
export function broadcast(sessionId, buildPayload) {
  const sockets = socketsBySession.get(sessionId);
  if (!sockets) return;
  for (const meta of sockets) {
    const payload = buildPayload(meta);
    if (payload === null || payload === undefined) continue;
    if (meta.ws.readyState === meta.ws.OPEN) {
      meta.ws.send(JSON.stringify(payload));
    }
  }
}
