import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions, dmPresent, forageViewForPlayer } from '$vtt/store.js';
import { query } from '$lib/server/db';
import { getUnmarkedSelfFind } from '$lib/server/services/forage';
import { findPendingForUser, resolveForageRoom } from '$lib/server/vttForage';
import { checkForageAvailability, loadOwnedCharacter, playerUnmarked, shortText } from '$lib/server/vttForageApi';

// The finder's private forage state, owner-checked. This is the "fetch" half of the sheet's
// nudge-plus-fetch delivery (the room only ever pushes a detail-free forage:ping), and what a popup
// reads on open. GET /vtt/api/forage/mine?characterId=<id>[&roomId=<code>]
//
//   roomId       the room the caller is in (their active room unless a VTT tab passes its own)
//   inRoom       that room is live
//   dmPresent    a DM-mode forage would be used right now (live account GM)
//   pending      the caller's in-flight DM request, player view only (never choice or preview)
//   lastDm       the last closed DM-mode result, until dismissed
//   unmarkedSelf a self-serve check waiting to be marked (with its character's name)
//   pendingCharacter the character the pending request is for, so a sheet can tell "mine" from
//                a different character's (one forage in flight per USER, not per character)
//   available    can this character start a forage right now? (a campaign, the right room, a campaign with
//                tables). unavailableReason is 'no_campaign' | 'wrong_room' | 'no_tables' | null: campaign-level
//                only, never anything about individual tables.
//   serverNow    the server clock, so a client can compare lastDm.closedAt without trusting its own clock
export const GET: RequestHandler = async ({ locals, url }) => {
  const userId = locals.user!.id;
  const characterId = url.searchParams.get('characterId');
  const owned = await loadOwnedCharacter(userId, characterId);
  if (!owned) return json({ error: 'not_found' }, { status: 404 });

  const room = resolveForageRoom({
    userId, roomId: shortText(url.searchParams.get('roomId'), 64) || null, characterId: characterId!,
    activeRoomId: owned.activeRoomId
  });
  const session = room.error ? null : room.session;

  const pending = findPendingForUser(userId);
  // Closed results live on the room they ran in. Look in this room first, then any other.
  let lastDm = session?.forageResults?.[userId] ?? null;
  if (!lastDm) {
    for (const other of sessions.values()) {
      if (other.forageResults?.[userId]) { lastDm = other.forageResults[userId]; break; }
    }
  }

  const unmarked = playerUnmarked(await getUnmarkedSelfFind(userId));
  let unmarkedSelf = null;
  if (unmarked) {
    const named = await query<{ name: string }>('SELECT name FROM characters WHERE id = $1', [unmarked.characterId]);
    unmarkedSelf = { ...unmarked, characterName: named.rows[0]?.name ?? 'your character' };
  }

  const availability = await checkForageAvailability(owned, session);

  return json({
    available: availability.available,
    unavailableReason: availability.available ? null : availability.reason,
    serverNow: Date.now(),
    roomId: session?.id ?? null,
    inRoom: !!session,
    dmPresent: session ? dmPresent(session) : false,
    pending: pending ? forageViewForPlayer(pending.request) : null,
    pendingRoomId: pending?.session.id ?? null,
    pendingCharacter: pending ? { id: pending.request.characterId, name: pending.request.characterName } : null,
    lastDm,
    unmarkedSelf
  });
};
