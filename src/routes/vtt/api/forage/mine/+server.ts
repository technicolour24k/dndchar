import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions, dmPresent, forageViewForPlayer } from '$vtt/store.js';
import { getUnmarkedSelfFind } from '$lib/server/services/forage';
import { findPendingForUser, resolveForageRoom } from '$lib/server/vttForage';
import { loadOwnedCharacter, playerUnmarked, shortText } from '$lib/server/vttForageApi';

// The finder's private forage state, owner-checked. This is the "fetch" half of the sheet's
// nudge-plus-fetch delivery (the room only ever pushes a detail-free forage:ping), and what a popup
// reads on open. GET /vtt/api/forage/mine?characterId=<id>[&roomId=<code>]
//
//   roomId       the room the caller is in (their active room unless a VTT tab passes its own)
//   inRoom       that room is live
//   dmPresent    a DM-mode forage would be used right now (live account GM)
//   pending      the caller's in-flight DM request, player view only (never choice or preview)
//   lastDm       the last closed DM-mode result, until dismissed
//   unmarkedSelf a self-serve check waiting to be marked
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

  return json({
    roomId: session?.id ?? null,
    inRoom: !!session,
    dmPresent: session ? dmPresent(session) : false,
    pending: pending ? forageViewForPlayer(pending.request) : null,
    pendingRoomId: pending?.session.id ?? null,
    lastDm,
    unmarkedSelf: playerUnmarked(await getUnmarkedSelfFind(userId))
  });
};
