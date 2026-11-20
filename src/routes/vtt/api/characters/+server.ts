import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listCharacters } from '$lib/server/services/characters';
import { listCampaignPickerCharacters } from '$lib/server/services/campaigns';
import { isRoomGm } from '$lib/server/vttForage';
import { sessions } from '$vtt/store.js';

// Minimal shape for the VTT's "pick a character" combobox - id/name plus
// enough to disambiguate at a glance. No portrait field exists anywhere in
// this codebase yet, so there's nothing to include for one.
//
// GET /vtt/api/characters?roomId=<code>
//   - roomId is a live campaign room: the room's GM gets every character the campaign has flagged
//     active in the party (with ownerUserId / ownerName, so the token can be given to its player);
//     anyone else gets their own characters in that campaign only.
//   - no roomId, or a Quick room (no campaign), or a room that isn't live: the caller's own
//     characters, exactly as before.
export const GET: RequestHandler = async ({ locals, url }) => {
  const user = locals.user!;
  const roomId = (url.searchParams.get('roomId') ?? '').trim().toUpperCase();
  const session = roomId ? sessions.get(roomId) : null;
  if (session?.campaignId) {
    return json(await listCampaignPickerCharacters(session.campaignId, user.id, isRoomGm(session, user.id)));
  }
  return json(await listCharacters(user.id));
};
