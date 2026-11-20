import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { getCampaignAccess, isUuid } from '$lib/server/services/access';
import { openCampaignRoomForMember } from '$lib/server/services/campaignRooms';
import { issueJoinTicket } from '$vtt/store.js';

// POST /vtt/api/campaigns/<id>/ticket  { role: 'gm' | 'player', takeoverOf?: 'self' | 'co' }
//
// The only way into a campaign's VTT room. This route has the cookie session and the database, the
// websocket server has neither, so the membership check happens here and the result travels as a
// short-lived single-use ticket (see vtt/server/handlers/join.js, which takes the user's identity,
// role and GM-seat rank from the ticket and ignores whatever the client sends).
//
// Real membership only: the site-admin override does NOT apply, an admin who isn't a member gets
// no ticket (they can join with the invite code like anyone). Archived campaigns have no table.
//
//   not a member / archived campaign -> 403 not_member     (404 if the campaign doesn't exist)
//   'gm' from a player               -> 403 not_dm
//   takeoverOf from a plain player  -> 403 not_dm
//
// takeoverOf says which takeover the client was offered: 'self' (replace my own older socket) or
// 'co' (primary DM replacing the co-DM). It is passed through for any DM: whether it applies (the primary DM over the co-DM, or a DM
// over their own older socket) is decided by the join handler, which knows who holds the seat.
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const user = locals.user!;
  const campaignId = params.id;
  if (!isUuid(campaignId)) return json({ error: 'campaign_not_found' }, { status: 404 });

  const campaign = await query<{ id: string; name: string; room_code: string }>(
    'SELECT id, name, room_code FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaign.rows[0]) return json({ error: 'campaign_not_found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const role = body?.role === 'gm' ? 'gm' : body?.role === 'player' ? 'player' : null;
  if (!role) return json({ error: 'invalid_role' }, { status: 400 });
  const takeoverOf = body?.takeoverOf === 'self' || body?.takeoverOf === 'co' ? body.takeoverOf : null;

  const access = await getCampaignAccess({ query }, user.id, campaignId);
  if (!access || access.archived || !access.role) return json({ error: 'not_member' }, { status: 403 });
  if (role === 'gm' && access.role === 'player') return json({ error: 'not_dm' }, { status: 403 });
  if (takeoverOf && access.role === 'player') return json({ error: 'not_dm' }, { status: 403 });

  // The GM-seat rank: the primary DM outranks the co-DM; a player ticket carries none.
  const seat = role === 'gm' ? (access.role === 'dm' ? 'primary' : 'co') : null;

  const roomCode = campaign.rows[0].room_code;
  // Re-checks membership and archived state around creating the room, so a removal or archive that
  // lands mid-request can't leave a phantom room. A removal in the few milliseconds after this and
  // before the socket joins is covered by ticket revocation (kickFromCampaignRoom).
  const stillMember = await openCampaignRoomForMember({ id: campaignId, roomCode }, user.id);
  if (!stillMember) return json({ error: 'not_member' }, { status: 403 });
  // The sheet's Activity Log follows this, so a member's rolls and notes land in the campaign room.
  await query('UPDATE users SET active_vtt_session_id = $1 WHERE id = $2', [roomCode, user.id]);

  const ticket = issueJoinTicket({ sessionId: roomCode, userId: user.id, displayName: user.displayName, role, seat, takeoverOf });
  return json({
    sessionId: roomCode,
    ticket,
    role,
    campaignName: campaign.rows[0].name,
    userId: user.id,
    displayName: user.displayName
  });
};
