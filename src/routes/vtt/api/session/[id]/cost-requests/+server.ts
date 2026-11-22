import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions } from '$vtt/store.js';
import { logRoll } from '$lib/server/services/rollLog';
import { isRoomGm } from '$lib/server/vttForage';
import { broadcastCostUpdate, closeCostRequest, costMap, denyLogMessage, getCostRequest } from '$lib/server/vttCostApproval';

// The room GM's cost-approval actions (cost-engine plan, unit 5). GM-only (isRoomGm: the caller's
// account is the live GM of this room, so a site admin or a plain campaign DM who isn't the room GM
// gets 403).
//
//   approve  { requestId, waive? }  the player may now run the activation once, within 15 minutes. It pays what it can;
//                                   waive lets it through paying nothing.
//   deny     { requestId }          cancels the request. Nothing is spent. Posts a roll-log line.
//
// Every action echoes the request id: a stale click gets 409 stale_request.

const err = (error: string, status: number, extra: Record<string, unknown> = {}) => json({ error, ...extra }, { status });

export const POST: RequestHandler = async ({ locals, params, request: httpRequest }) => {
  const session = sessions.get(params.id!);
  if (!session) return err('session_not_found', 404);
  if (!isRoomGm(session, locals.user!.id)) return err('not_gm', 403);

  const body = await httpRequest.json().catch(() => ({}));
  costMap(session);
  const request = getCostRequest(session, body?.requestId);
  if (!request) return err('stale_request', 409);
  if (request.busy) return err('busy', 409);

  const action = body?.action;
  if (action !== 'approve' && action !== 'deny') return err('invalid_action', 400);
  // Only a waiting request can be decided. (An approved one can't be approved twice or denied after the fact.)
  if (request.status !== 'pending') return err('wrong_status', 409, { status: request.status });

  request.busy = true;
  try {
    if (action === 'approve') {
      request.status = 'approved';
      request.approvedBy = locals.user!.id;
      request.approvedByName = locals.user!.displayName;
      request.approvedAt = Date.now();
      request.waive = body?.waive === true;
      broadcastCostUpdate(session, request);
      return json({ ok: true });
    }
    closeCostRequest(session, request, 'denied');
    try {
      await logRoll(session.id, denyLogMessage(request), { kind: 'cost_denied', characterId: request.characterId }, 'public');
    } catch (error) {
      console.error('[cost-requests] could not write the roll-log line', error);
    }
    return json({ ok: true });
  } finally {
    request.busy = false;
  }
};
