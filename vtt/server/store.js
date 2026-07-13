// @ts-nocheck — plain untyped JS by design (see vtt/README.md); shared as-is
// between the SvelteKit route bundle, the Vite dev plugin, and server.js.
import crypto from 'node:crypto';

// Excludes 0/O/1/I to avoid ambiguity when a room code is read aloud/typed.
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;

// This module is reachable from two different loading paths in the same
// process: directly (vite.config.ts's dev plugin / server.js in prod) and
// indirectly via SvelteKit's bundled `+server.ts` routes (through the $vtt
// alias). Those two paths aren't guaranteed to resolve to the same module
// instance, so the actual state lives on `globalThis` — both paths end up
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
  };
}

// Strips secret info from a single token for a player-role recipient.
// Enemy/npc tokens never expose real stats to players — only the GM-set
// coarse `condition` field, if present. PC tokens are untouched (HP isn't
// secret between allies).
export function filterTokenForPlayer(token) {
  if (token.type === 'enemy' || token.type === 'npc') {
    const { stats, ...rest } = token;
    if (token.condition !== undefined) rest.condition = token.condition;
    return rest;
  }
  return token;
}

// Canonical filter used both for state:full on join and for filtering any
// broadcast that includes token data. GM always gets the unfiltered session.
export function filterSessionForRole(session, role) {
  if (role === 'gm') return session;

  const tokens = {};
  for (const [id, token] of Object.entries(session.tokens)) {
    if (token.hidden) continue;
    tokens[id] = filterTokenForPlayer(token);
  }
  return { ...session, tokens };
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
