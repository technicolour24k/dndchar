import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { dmPresent, costViewForPlayer } from '$vtt/store.js';
import { query, withTransaction } from '$lib/server/db';
import { getCharacterAccess } from '$lib/server/services/access';
import { loadCostCharacter } from '$lib/server/vttCostGate';
import { previewActivationCost } from '$lib/server/services/cost-engine';
import {
  broadcastCostUpdate, closeCostRequest, costMap, findOwnCostRequest, isActorDm, newCostRequest, parseActivation, resolveCostRoom, roomMatchesCampaign,
  sweepExpiredCostRequests
} from '$lib/server/vttCostApproval';

// Player-facing cost-approval actions (cost-engine plan, unit 5). All writes are HTTP, the socket only
// notifies. The request lives in memory on the room (session.costRequests[characterId]).
//
//   ask       { characterId, activation, roomId? }  asks the room's DM to let an unaffordable activation through
//   withdraw  { requestId }                          takes the request back (any time before it is being used)
//
// Statuses: 400 bad input, 403 not in that room, 404 not your character, 409 a conflict the client can act on:
//   no_dm (nobody to ask: show "Did your DM OK this?"), dm_self (you are the DM: go ahead yourself),
//   pending (one request per character), stale_request, cannot_withdraw.

const err = (error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, ...extra }, { status });

export const POST: RequestHandler = async ({ locals, request }) => {
  const userId = locals.user!.id;
  const body = await request.json().catch(() => ({}));
  try {
    if (body?.action === 'ask') return await askAction(userId, locals.user!.displayName, body);
    if (body?.action === 'withdraw') return withdrawAction(userId, body);
  } catch (error) {
    console.error('[cost-requests] action failed', body?.action, error);
    return err('server_error', 500);
  }
  return err('invalid_action', 400);
};

async function askAction(userId: string, displayName: string, body: any) {
  const characterId: string = typeof body?.characterId === 'string' ? body.characterId : '';
  const activation = parseActivation(body?.activation);
  if (!activation) return err('bad_activation', 400);
  // Owner or campaign DM/co-DM only (a site admin can edit a sheet but doesn't act for a player).
  const access = await getCharacterAccess({ query }, userId, characterId);
  if (!access?.canAct) return err('not_found', 404);
  const character = await loadCostCharacter(characterId);
  if (!character) return err('not_found', 404);

  // The activation must be this character's own (the preview below reads counters by id).
  if (activation.kind === 'spell_access') {
    const owns = await query('SELECT 1 FROM character_inventory_items WHERE id = $1 AND character_id = $2', [activation.inventoryItemId, characterId]);
    if (!owns.rowCount) return err('not_found', 404);
  }

  const room = resolveCostRoom({
    userId, roomId: typeof body?.roomId === 'string' && body.roomId.length <= 64 ? body.roomId : null,
    ownerActiveRoomId: character.active_vtt_session_id, characterCampaignId: character.campaign_id, campaignRoomCode: character.room_code
  });
  if (room.error) return err(room.error, 403);
  const session = room.session;
  if (isActorDm({ isCampaignDm: access.isCampaignDm, session, userId, characterCampaignId: character.campaign_id })) return err('dm_self', 409, { mode: 'dm_self' });
  if (!session || !dmPresent(session)) return err('no_dm', 409, { mode: 'no_dm' });

  // Sweep: approvals past their window go, and so does a waiting request whose requester can no longer
  // act for the character or whose character has left this room's campaign.
  sweepExpiredCostRequests(session);
  const stale = costMap(session)[characterId];
  if (stale) {
    const requesterAccess = await getCharacterAccess({ query }, stale.playerId, characterId);
    if (!requesterAccess?.canAct || !roomMatchesCampaign(session, character.campaign_id)) closeCostRequest(session, stale, 'withdrawn');
  }

  // Read-only: is it still short? (It may have been refilled since the 409.)
  let preview;
  try {
    preview = await withTransaction((client) => previewActivationCost(client, characterId, activation));
  } catch (error) {
    return err('bad_activation', 400, { message: error instanceof Error ? error.message : undefined });
  }
  if (!preview.shortfalls.length) return json({ notNeeded: true });

  // No await between this check and the set, so two quick asks can't both get in.
  const existing = costMap(session)[characterId];
  if (existing) return err('pending', 409, { request: costViewForPlayer(existing) });
  const created = newCostRequest({
    characterId, characterName: character.name, playerId: userId, playerName: displayName,
    source: typeof body?.roomId === 'string' && body.roomId ? 'vtt' : 'sheet',
    activation, activationLabel: preview.label, shortfalls: preview.shortfalls
  });
  costMap(session)[characterId] = created;
  broadcastCostUpdate(session, created);
  return json({ roomId: session.id, request: costViewForPlayer(created) });
}

function withdrawAction(userId: string, body: any) {
  const found = findOwnCostRequest(userId, body?.requestId);
  if (!found) return err('stale_request', 409);
  // 'used' means the approved activation is running right now: too late to take it back.
  if (found.request.status === 'used') return err('cannot_withdraw', 409);
  closeCostRequest(found.session, found.request, 'withdrawn');
  return json({ ok: true });
}
