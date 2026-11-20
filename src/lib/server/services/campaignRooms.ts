import { query } from '$lib/server/db';
import { getCampaignAccess } from '$lib/server/services/access';
import { disconnectAllFromRoom, disconnectUserFromRoom, ensureRoom, revokeJoinTickets, revokeRoomTickets, revokeStaleGmTickets, sessions, setGmSeat, socketsBySession } from '$vtt/store.js';

// A campaign's table: the in-memory VTT room that has the campaign's fixed room code. The room
// state (map, tokens) lives in memory only, by agreement; what survives a restart is the code and
// the active game session row, which openCampaignRoom re-attaches.

/**
 * Opens (creates if missing) the campaign's live room and returns it. A freshly created room has
 * no game session attached, so the campaign's newest active one is re-attached, which keeps
 * Session Notes working across a server restart.
 */
export async function openCampaignRoom(campaign: { id: string; roomCode: string }) {
  const session = ensureRoom(campaign.roomCode, campaign.id);
  if (!session.gameSessionId) {
    const active = await query<{ id: string }>(
      'SELECT id FROM game_sessions WHERE campaign_id = $1 AND is_active = true ORDER BY created_at DESC LIMIT 1',
      [campaign.id]
    );
    // Re-check after the await: another request may have attached one in the meantime.
    if (active.rows[0] && !session.gameSessionId) session.gameSessionId = active.rows[0].id;
  }
  return session;
}

/**
 * Opens the room for a real member, guarding against a concurrent archive or removal: membership
 * and archived state are checked just before the room is created and again straight after, and if
 * the second check fails the room is torn down again so an archived campaign can't be left with a
 * phantom room. Returns the member's role, or null if they may not open it. (The admin override
 * does not apply: only a real membership counts.)
 */
export async function openCampaignRoomForMember(campaign: { id: string; roomCode: string }, userId: string): Promise<'dm' | 'co_dm' | 'player' | null> {
  const allowed = (access: Awaited<ReturnType<typeof getCampaignAccess>>) => (access && !access.archived && access.role ? access.role : null);
  if (!allowed(await getCampaignAccess({ query }, userId, campaign.id))) return null;
  await openCampaignRoom(campaign);
  const recheck = await getCampaignAccess({ query }, userId, campaign.id);
  const after = allowed(recheck);
  if (!after) {
    // Only an archive means the room shouldn't exist; a removed member just doesn't get in.
    if (recheck?.archived) closeCampaignRoom(campaign.roomCode);
    return null;
  }
  return after;
}

/**
 * Kicks a removed (or demoted) user's sockets from the campaign's room, if it is live. Their
 * unspent join tickets are revoked first, so a ticket issued a moment before the change can't
 * let them straight back in.
 */
export function kickFromCampaignRoom(roomCode: string | undefined, userId: string | undefined, reason: 'removed_from_campaign' | 'role_changed') {
  if (!roomCode || !userId) return;
  revokeJoinTickets(roomCode, userId);
  disconnectUserFromRoom(roomCode, userId, reason);
}

/**
 * An archived campaign has no table: revoke every ticket, kick everyone and drop the in-memory
 * room (the roll log and game session rows stay in the database).
 */
export function closeCampaignRoom(roomCode: string | undefined) {
  if (!roomCode) return;
  revokeRoomTickets(roomCode);
  disconnectAllFromRoom(roomCode, 'removed_from_campaign');
  sessions.delete(roomCode);
  socketsBySession.delete(roomCode);
}

/**
 * After a membership change committed: brings the GM-seat rank on every live GM socket in the
 * room in line with the member's current role ('dm' -> 'primary', 'co_dm' -> 'co'), so a swap,
 * an admin "make primary" or a co-DM auto-promotion is reflected in who may take over from whom.
 * A seated primary who became co-DM keeps the seat but is now 'co', so the new primary gets the
 * takeover offer. Sockets of users who are no longer DMs are kicked separately.
 *
 * Unspent GM tickets whose seat no longer matches are revoked as well, so a ticket issued just
 * before a swap can't seat someone with their old rank (the client just asks for a fresh one).
 *
 * Best-effort catch-up AFTER the membership change committed: an error is logged, never thrown,
 * so a hiccup here can't turn a saved change into a 500.
 */
export async function syncGmSeats(campaignId: string, roomCode: string | undefined) {
  if (!roomCode) return;
  try {
    const members = await query<{ user_id: string; role: string }>(
      `SELECT user_id, role FROM campaign_members WHERE campaign_id = $1 AND role IN ('dm', 'co_dm')`,
      [campaignId]
    );
    const seatByUser = new Map<string, 'primary' | 'co'>(
      members.rows.map((row) => [row.user_id, row.role === 'dm' ? 'primary' : 'co'])
    );
    revokeStaleGmTickets(roomCode, seatByUser);
    for (const [userId, seat] of seatByUser) setGmSeat(roomCode, userId, seat);
  } catch (err) {
    console.error('syncGmSeats failed (membership change was saved):', err);
  }
}
