import { socketsBySession, broadcast, registerReleaseHook } from '$vtt/store.js';
import {
  announce, dropMember, expectedUserIds, gmView, isComplete, openPending, playerIsConnected, setHolding, setReady
} from '$vtt/roundState.js';
import { query } from '$lib/server/db';
import { getCharacterAccess } from '$lib/server/services/access';
import { advanceCharacterRound } from '$lib/server/services/catalogue';
import { getTurnView } from '$lib/server/services/turn-state';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { resetSessionMovement, trimTurnView } from '$lib/server/vttTurn';

// The room's table-wide round (vtt-feedback units 9, 10 and 12). The GM asks for it; it WAITS for every
// connected player who owns a character with a token on the map to press Ready (or for the GM to press
// Start now), and only then does anything reset or tick. The waiting state is session.roundPending
// (vtt/server/roundState.js, in memory on the room); this file is the part that touches the database.
//
// Two ways in, both plain HTTP like forage and cost approval, because the identity comes from the signed-in
// account (locals.user) and never from anything the client sends: the GM route (request, start, cancel)
// and the player route (ready, hold). Results go out over the socket.
//
// Exactly once: processPending() takes the pending round off the session in the same synchronous step that
// checks it, before its first await. Ready, Start now and a disconnect racing each other therefore see
// either the round or nothing, so it can only ever be processed once.

export type Outcome = { status: number; body: Record<string, unknown> };

const TOO_SOON_MS = 2000;

// The room GM's request. If nobody is expected it processes straight away (the unit 9 behaviour).
export async function requestRound(session: any, gmUserId: string): Promise<Outcome> {
  if (session.roundPending) return { status: 409, body: { error: 'already_pending', pending: gmView(session.roundPending) } };
  // A double click (or a second GM tab) must not tick effects twice: refused while one is still running
  // (the loop can outlast 2 s on a slow DB) and for 2 s after it finishes.
  if (session.nextRoundRunning || (session.lastNextRoundAt && Date.now() - session.lastNextRoundAt < TOO_SOON_MS)) {
    return { status: 409, body: { error: 'too_soon' } };
  }
  const pending = openPending(session, expectedUserIds(session, socketsBySession.get(session.id)), gmUserId);
  if (isComplete(pending)) return processPending(session); // nobody to wait for
  announce(session, broadcast, 'round:pending');
  return { status: 200, body: { pending: gmView(pending) } };
}

// GM "Start now": process whatever is pending, ready or not.
export function startRound(session: any, gmUserId: string): Promise<Outcome> {
  return processPending(session, gmUserId);
}

// GM "Cancel": nothing is processed. The GM and the players who were being waited on are told.
export function cancelRound(session: any): Outcome {
  const pending = session.roundPending;
  if (!pending) return { status: 409, body: { error: 'no_pending' } };
  session.roundPending = null;
  const involved = new Set(Object.keys(pending.members));
  broadcast(session.id, (recipient: any) => (recipient.role === 'gm' || (recipient.role === 'player' && involved.has(recipient.playerId)) ? { type: 'round:cancelled' } : null));
  return { status: 200, body: { cancelled: true } };
}

// A player's Ready or Hold on. userId is the signed-in account, never taken from the body. A user who
// isn't being waited on gets 409 and nothing changes.
export async function playerSignal(session: any, userId: string, action: 'ready' | 'hold', pendingId?: string): Promise<Outcome> {
  const pending = session.roundPending;
  if (!pending) return { status: 409, body: { error: 'no_pending' } };
  // A click on a card from an earlier round (cancelled, then a new one opened) must not answer the new one.
  if (pendingId !== pending.id) return { status: 409, body: { error: 'stale_round' } };
  if (!(action === 'hold' ? setHolding(session, userId) : setReady(session, userId))) {
    return { status: 409, body: { error: 'not_expected' } };
  }
  if (action === 'hold') {
    const name = pending.members[userId].name;
    broadcast(session.id, (recipient: any) => (recipient.role === 'gm' ? { type: 'round:hold', name } : null));
  }
  if (shouldProcess(pending)) await processPending(session);
  else announce(session, broadcast);
  return { status: 200, body: { ok: true } }; // the player never gets the round's result, only the GM does
}

// Everyone left has pressed Ready. An empty set does NOT count here: if the only expected player's tab is
// reloading, the round must wait for them to come back (the GM can still Start now or Cancel).
function shouldProcess(pending: any): boolean {
  return Object.keys(pending.members).length > 0 && isComplete(pending);
}

// A player's socket went away. If that was their last one they stop being waited on, which may complete the
// round. Registered once with the store, so it applies to every room.
registerReleaseHook('nextRound', (meta: any, session: any) => {
  const pending = session.roundPending;
  if (!pending || meta.role !== 'player' || !meta.playerId) return;
  if (playerIsConnected(socketsBySession.get(session.id), meta.playerId)) return; // another tab is still here
  if (!dropMember(session, meta.playerId)) return;
  if (shouldProcess(pending)) {
    processPending(session).catch((error) => console.error('[next-round] could not process after a disconnect', error));
  } else {
    announce(session, broadcast);
  }
});

// Takes the pending round off the session and runs it. The synchronous take is what makes it exactly-once.
// `actorId` is the GM who pressed Start now, if that is how it got here. Otherwise the current room GM is
// used (session.gmSocketId holds the GM's account id, or the placeholder 'gm' for a GM with no account), and
// failing that whoever requested the round. That user's edit rights decide which characters advance.
export async function processPending(session: any, actorId?: string): Promise<Outcome> {
  const pending = session.roundPending;
  if (!pending) return { status: 409, body: { error: 'no_pending' } };
  session.roundPending = null;
  session.nextRoundRunning = true;
  session.lastNextRoundAt = Date.now();
  try {
    const result = await runNextRound(session, actorId ?? (session.gmSocketId && session.gmSocketId !== 'gm' ? session.gmSocketId : pending.requestedBy));
    // Players: the round has started (detail-free). GM: the turn views to push onto the tokens, which also
    // covers a round a player's Ready or a disconnect completed, when no GM request is waiting for them.
    broadcast(session.id, (recipient: any) => {
      if (recipient.role === 'gm') return { type: 'round:done', ...result };
      return recipient.role === 'player' ? { type: 'round:next' } : null; // watchers get nothing
    });
    return { status: 200, body: result };
  } finally {
    // Cleared even on an error, so the guard can never wedge; the 2 s window restarts from the end.
    session.nextRoundRunning = false;
    session.lastNextRoundAt = Date.now();
  }
}

// Every character on the map goes through the sheet's Next Round (round effects tick, round counters
// refill, spent actions and follow-ups clear), turn-based effects tick too, and every token's movement goes
// back to full. Characters are the distinct ones on tokens (the same set as turn-reset), advanced only where
// the requesting GM may edit them.
// Lock order: each character is its own transaction (advanceCharacterRound takes the turn row first,
// then slots, counters, inventory, resources), so no transaction ever holds two characters' locks.
// Ascending id keeps the order deterministic. One failing character is logged and skipped.
async function runNextRound(session: any, userId: string) {
  const ids = [...new Set(Object.values<any>(session.tokens ?? {}).map((token) => token.characterId).filter((id): id is string => typeof id === 'string' && id.length > 0))].sort();
  const views: Record<string, unknown> = {};
  let skipped = 0;
  for (const characterId of ids) {
    try {
      const access = await getCharacterAccess({ query }, userId, characterId);
      if (!access?.canEdit) { skipped += 1; continue; }
      await advanceCharacterRound(userId, characterId, { tickTurnEffects: true });
      emitRealtimeEvent('round:advanced', { characterId }); // sheets refresh; token AC follows an expired AC effect
      views[characterId] = trimTurnView(await getTurnView({ query }, characterId));
    } catch (error) {
      console.error('[next-round] could not advance a character', characterId, error);
      skipped += 1;
    }
  }
  resetSessionMovement(session);
  return { advanced: Object.keys(views).length, skipped, views };
}
