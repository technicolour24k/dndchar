import crypto from 'node:crypto';
import { sessions, socketsBySession, broadcast, publish, dmPresent, findLiveGmSocket, forageViewForPlayer } from '$vtt/store.js';
import type { ForageCheck } from '$lib/types/forage';

// Forage lifecycle helpers for DM mode (docs: vtt-forage plan, unit B). Mostly synchronous so they
// can be tested with fake sessions. The request lives in memory on the room: session.forage[userId].
//
// GM identity: session.gmSocketId holds the GM's player id, which is the account user id when the
// GM came through the app's VTT link (despite the name it is never a socket id). A GM who opened
// the VTT directly has the placeholder 'gm' and so can't act on requests over HTTP.

export type ForageStage = 'requested' | 'checked' | 'preview' | 'approving';

export type ForageChoice = {
  skillKey: string;
  areaType: string;
  category: string;
  tableId: string;
  advantage: { disabled: string[]; situationalAdvantage: number; situationalDisadvantage: number };
};

export type ForagePreview = {
  tableId: string;
  tableName: string;
  nat20: boolean;
  runs: number;
  lines: Array<{ itemId: string; name: string; qty: number }>;
  tableEntries: Array<{ itemId: string; name: string; chance: number; qtyDie: number; archived: boolean }>;
};

/** The in-memory DM-mode request. The GM sees all of it, the finder only forageViewForPlayer. */
export type ForageRequest = {
  id: string;
  playerId: string;
  playerName: string;
  characterId: string;
  characterName: string;
  tokenId: string | null;
  source: 'vtt' | 'sheet';
  stage: ForageStage;
  createdAt: number;
  choice: ForageChoice;
  /** DM-side reminder for the chosen table (Q9). GM-only: forageViewForPlayer never copies it. */
  suggestedCheck: string;
  check: ForageCheck | null;
  preview: ForagePreview | null;
  /** True while an async GM action is mid-flight, so a double click can't run it twice. Not sent to the finder. */
  busy?: boolean;
};

export type ForageOutcome = 'failed' | 'approved' | 'cancelled';

/** The last closed DM-mode result, kept so a finder who wasn't watching still sees it. */
export type ForageResult = {
  requestId: string;
  characterId: string;
  outcome: ForageOutcome;
  check: ForageCheck | null;
  lines?: Array<{ itemId: string; name: string; qty: number }>;
  findId?: string;
  shared?: boolean;
  closedAt: number;
};

// The shapes broadcast() recipients take (real sockets, plus a synthetic watcher).
type Recipient = { role: string | null; playerId: string | null };

// --- Guards ---------------------------------------------------------------------------------

/**
 * Is this caller the room's GM? Only an account GM can be: their user id is stored in gmSocketId AND
 * a live GM socket joined with that same id (meta.gmUserId), so a GM who has left stops counting.
 * In a campaign room the claim is trustworthy: the seat comes from a join ticket issued after a real
 * membership check (vtt/server/handlers/join.js). In a Quick room it is still the pre-existing POC
 * model: the ws join just trusts the playerId it is sent, so this can't be stronger than that claim.
 */
export function isRoomGm(session: { id?: string; gmSocketId?: string | null }, userId: string | null | undefined): boolean {
  if (!userId || session.gmSocketId !== userId) return false;
  const live = findLiveGmSocket(socketsBySession.get(session.id as string));
  return !!live && live.gmUserId === userId;
}

/** Rooms made before the forage deploy have no forage maps, so every access goes through these. */
export function forageMap(session: any): Record<string, ForageRequest> {
  return (session.forage ??= {});
}
export function forageResultsMap(session: any): Record<string, ForageResult> {
  return (session.forageResults ??= {});
}

/** The user's pending DM request in any live room (a scan of the tiny sessions map). */
export function findPendingForUser(userId: string): { session: any; request: ForageRequest } | null {
  for (const session of sessions.values()) {
    const request = session.forage?.[userId];
    if (request) return { session, request };
  }
  return null;
}

export function getRequest(session: any, requestId: unknown): ForageRequest | null {
  if (typeof requestId !== 'string') return null;
  for (const request of Object.values(session.forage ?? {}) as ForageRequest[]) {
    if (request.id === requestId) return request;
  }
  return null;
}

/**
 * May the finder withdraw? While the request is only 'requested', yes. With the DM gone (no live GM
 * socket) at any stage except 'approving'. With a DM present, not after they've seen a roll, so
 * nobody withdraws after a bad check.
 */
export function canWithdraw(session: any, request: ForageRequest): boolean {
  if (request.stage === 'requested') return true;
  // dmPresent (not just a live socket): a placeholder-GM reconnect can't act on requests either.
  return !dmPresent(session) && request.stage !== 'approving';
}

export function newRequest(input: {
  playerId: string; playerName: string; characterId: string; characterName: string; tokenId: string | null;
  source: 'vtt' | 'sheet'; choice: ForageChoice; suggestedCheck?: string;
}): ForageRequest {
  return {
    id: crypto.randomUUID(), ...input, suggestedCheck: input.suggestedCheck ?? '', stage: 'requested', createdAt: Date.now(),
    check: null, preview: null
  };
}

// --- Which room, which token ------------------------------------------------------------------

export type ResolvedRoom =
  | { session: any | null; token: any | null; error?: undefined }
  | { session?: undefined; token?: undefined; error: 'not_in_room' | 'bad_token' };

/**
 * Works out the live room and token a forage belongs to.
 *   - VTT start (roomId given): a room that no longer exists counts as "no room" (self-serve). In a
 *     live room the user must be a player in it or own the token, and a tokenId must be theirs and
 *     linked to this character.
 *   - Sheet start (no roomId): the user's active room if it's live, else none. The token is the
 *     user's own token for this character in that room, if there is one.
 */
export function resolveForageRoom(input: {
  userId: string; roomId?: string | null; characterId: string; tokenId?: string | null; activeRoomId?: string | null;
}): ResolvedRoom {
  const { userId, characterId } = input;
  if (input.roomId) {
    const session = sessions.get(input.roomId);
    // A roomId that isn't live falls back to the owner's active room, so a junk field can't be used
    // to dodge a present DM. Only if that isn't live either is it genuinely no room.
    if (!session) return resolveForageRoom({ userId, characterId, tokenId: input.tokenId, activeRoomId: input.activeRoomId });
    const tokens = Object.values(session.tokens ?? {}) as any[];
    const ownsAToken = tokens.some((token) => token.ownerId === userId);
    if (!session.players?.[userId] && !ownsAToken) return { error: 'not_in_room' };
    if (input.tokenId) {
      const token = session.tokens?.[input.tokenId];
      if (!token || token.ownerId !== userId || token.characterId !== characterId) return { error: 'bad_token' };
      return { session, token };
    }
    return { session, token: tokens.find((token) => token.characterId === characterId && token.ownerId === userId) ?? null };
  }
  const session = input.activeRoomId ? sessions.get(input.activeRoomId) : undefined;
  if (!session) return { session: null, token: null };
  const tokens = Object.values(session.tokens ?? {}) as any[];
  return { session, token: tokens.find((token) => token.characterId === characterId && token.ownerId === userId) ?? null };
}

// --- Messages ---------------------------------------------------------------------------------

/**
 * forage:update for one recipient: the GM gets the whole request, the finder gets their player view,
 * everyone else (including a watcher, whose playerId is null) gets null so broadcast() skips them.
 */
export function forageMessageFor(recipient: Recipient, request: ForageRequest) {
  if (recipient.role === 'gm') return { type: 'forage:update', request };
  if (recipient.role === 'player' && recipient.playerId && recipient.playerId === request.playerId) {
    return { type: 'forage:update', request: forageViewForPlayer(request) };
  }
  return null;
}

/** forage:closed: the GM and the finder only. `result` is what the finder may see of the outcome. */
export function forageClosedFor(recipient: Recipient, request: ForageRequest, outcome: ForageOutcome, result: ForageResult | null) {
  const message = { type: 'forage:closed', requestId: request.id, playerId: request.playerId, outcome, result };
  if (recipient.role === 'gm') return message;
  if (recipient.role === 'player' && recipient.playerId && recipient.playerId === request.playerId) return message;
  return null;
}

/**
 * Detail-free "go and fetch your forage state" nudge for the finder's sheet, sent to the room's watch
 * topic. It carries only the user id. forage:ping is sent with publish() directly and is never
 * added to the watchable broadcast types, so nothing else can leak through that channel.
 */
export function forageNudge(sessionId: string, userId: string): void {
  publish(`room:${sessionId}`, { type: 'forage:ping', playerId: userId });
}

export function broadcastForageUpdate(session: any, request: ForageRequest): void {
  broadcast(session.id, (recipient: Recipient) => forageMessageFor(recipient, request));
  forageNudge(session.id, request.playerId);
}

export function broadcastForageClosed(session: any, request: ForageRequest, outcome: ForageOutcome, result: ForageResult | null): void {
  broadcast(session.id, (recipient: Recipient) => forageClosedFor(recipient, request, outcome, result));
  forageNudge(session.id, request.playerId);
}

/** Closes a DM-mode request: removes it, records the finder's last result (unless record is false), and tells GM and finder. */
export function closeRequest(
  session: any, request: ForageRequest, outcome: ForageOutcome, extra: Partial<ForageResult> = {}, record = true
): ForageResult | null {
  delete forageMap(session)[request.playerId];
  // record=false is for a finder's own withdrawal: they know, so there is no result to keep.
  const result: ForageResult | null = record
    ? { requestId: request.id, characterId: request.characterId, outcome, check: request.check, closedAt: Date.now(), ...extra }
    : null;
  if (result) forageResultsMap(session)[request.playerId] = result;
  broadcastForageClosed(session, request, outcome, result);
  return result;
}

// --- Roll-log wording -------------------------------------------------------------------------

/**
 * The public roll-log line for a closed forage. No item names (the haul is private unless shared).
 * "Thorne foraged (Nature 17, pass, self-served) and found 5 items." A natural 20 or 1 replaces the
 * number in the brackets.
 */
export function rollLogMessage(input: {
  characterName: string; check: ForageCheck; outcome: 'failed' | 'found'; mode: 'dm' | 'self'; itemCount: number;
}): string {
  const { characterName, check, outcome, mode, itemCount } = input;
  const roll = check.nat20 ? 'natural 20' : check.nat1 ? 'natural 1' : String(check.total);
  const parts = [`${check.skillLabel} ${roll}`, outcome === 'found' ? 'pass' : 'fail'];
  if (mode === 'self') parts.push('self-served');
  const found = outcome === 'found' && itemCount > 0
    ? `found ${itemCount} ${itemCount === 1 ? 'item' : 'items'}`
    : 'found nothing of note';
  return `${characterName} foraged (${parts.join(', ')}) and ${found}.`;
}
