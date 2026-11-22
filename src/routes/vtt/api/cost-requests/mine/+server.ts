import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dmPresent, costViewForPlayer } from '$vtt/store.js';
import { query } from '$lib/server/db';
import { getCharacterAccess } from '$lib/server/services/access';
import { loadCostCharacter } from '$lib/server/vttCostGate';
import { APPROVAL_TTL_MS, resolveCostRoom } from '$lib/server/vttCostApproval';

// The player's private cost-approval state for one character, the "fetch" half of the nudge-plus-fetch
// delivery (the room only ever pushes a detail-free cost:ping).
// GET /vtt/api/cost-requests/mine?characterId=<id>[&roomId=<code>]
//
//   dmPresent  a DM could be asked right now (live account GM in the room)
//   request    the caller's own request for this character, player view only (null if none)
//   expiresAt  when an approved request stops working (approvedAt + 15 minutes)
//   serverNow  the server clock, so a client needn't trust its own
export const GET: RequestHandler = async ({ locals, url }) => {
  const userId = locals.user!.id;
  const characterId = url.searchParams.get('characterId') ?? '';
  const access = await getCharacterAccess({ query }, userId, characterId);
  if (!access?.canAct) return json({ error: 'not_found' }, { status: 404 });
  const character = await loadCostCharacter(characterId);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  const roomParam = url.searchParams.get('roomId');
  const room = resolveCostRoom({
    userId, roomId: roomParam && roomParam.length <= 64 ? roomParam : null,
    ownerActiveRoomId: character.active_vtt_session_id, characterCampaignId: character.campaign_id, campaignRoomCode: character.room_code
  });
  const session = room.error ? null : room.session;
  const found = session?.costRequests?.[characterId];
  // Only the requester ever sees a request.
  const own = found && found.playerId === userId ? found : null;
  return json({
    serverNow: Date.now(),
    roomId: session?.id ?? null,
    inRoom: !!session,
    dmPresent: session ? dmPresent(session) : false,
    request: own ? costViewForPlayer(own) : null,
    expiresAt: own?.status === 'approved' && own.approvedAt ? own.approvedAt + APPROVAL_TTL_MS : null
  });
};
