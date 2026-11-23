import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions, broadcast } from '$vtt/store.js';
import { query } from '$lib/server/db';
import { isRoomGm } from '$lib/server/vttForage';
import { getCharacterAccess } from '$lib/server/services/access';
import { advanceCharacterRound } from '$lib/server/services/catalogue';
import { getTurnView } from '$lib/server/services/turn-state';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { resetSessionMovement, trimTurnView } from '$lib/server/vttTurn';

// The room GM's "Next round". There is no initiative tracker in the VTT, so this is the one table-wide
// round: every character on the map goes through the sheet's Next Round (round effects tick, round
// counters refill, spent actions and follow-ups clear), turn-based effects tick too, and every token's
// movement goes back to full. Room GM only (isRoomGm). Characters are the distinct ones on tokens
// (the same set as turn-reset), advanced only where the caller may edit them.
// Lock order: each character is its own transaction (advanceCharacterRound takes the turn row first,
// then slots, counters, inventory, resources), so no transaction ever holds two characters' locks.
// Ascending id keeps the order deterministic. One failing character is logged and skipped.
// Answers { advanced, skipped, views } where views maps characterId to the trimmed token.turn copy.
const TOO_SOON_MS = 2000;

export const POST: RequestHandler = async ({ locals, params }) => {
  const session = sessions.get(params.id!);
  if (!session) return json({ error: 'session_not_found' }, { status: 404 });
  if (!isRoomGm(session, locals.user!.id)) return json({ error: 'not_gm' }, { status: 403 });

  // A double click (or a second GM tab) must not tick effects twice. In memory is enough. Refused while
  // one is still running (the loop can outlast 2 s on a slow DB) and for 2 s after it finishes.
  const now = Date.now();
  if (session.nextRoundRunning || (session.lastNextRoundAt && now - session.lastNextRoundAt < TOO_SOON_MS)) {
    return json({ error: 'too_soon' }, { status: 409 });
  }
  session.nextRoundRunning = true;
  session.lastNextRoundAt = now;
  try {
    return await runNextRound(session, locals.user!.id);
  } finally {
    // Cleared even on an error, so the guard can never wedge; the 2 s window restarts from the end.
    session.nextRoundRunning = false;
    session.lastNextRoundAt = Date.now();
  }
};

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
  // Players get a detail-free nudge (the GM pressed the button, so the GM needs none). Not watchable.
  broadcast(session.id, (recipient: any) => (recipient.role === 'gm' ? null : { type: 'round:next' }));
  return json({ advanced: Object.keys(views).length, skipped, views });
}
