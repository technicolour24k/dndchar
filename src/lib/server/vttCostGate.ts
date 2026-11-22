import { dmPresent, sessions } from '$vtt/store.js';
import { query } from '$lib/server/db';
import { getCharacterAccess } from '$lib/server/services/access';
import { logRoll } from '$lib/server/services/rollLog';
import { CostShortfallError, type CostOverride } from '$lib/server/services/cost-engine';
import { activationSignature, overrideDecision, shortfallMode } from '$lib/rules/cost';
import type { Activation, ShortfallMode } from '$lib/types/cost';
import {
  approvalVerdict, claimApproval, closeCostRequest, costMap, findCostRequest, isActorDm, overrideLogMessage, releaseApproval,
  resolveCostRoom, type CostRequest
} from '$lib/server/vttCostApproval';

// The gate every cost-paying route goes through (sheet actions and the VTT roll-spell / roll-item).
// Before the transaction opens it works out, server-side, whether this activation may go over budget:
//   - an approvalId (the DM said yes): valid only for the same character, the same activation
//     signature, the player who asked, within 15 minutes, once. It is claimed here, synchronously.
//   - override 'dm': the actor really is the campaign DM/co-DM or the room GM.
//   - override 'self': only when no DM is present right now (the player confirmed "Did your DM OK this?").
// Anything else leaves the activation to fail with a shortfall (and `mode` says which prompt to show).
// The gate only grants the right to overspend: an activation that is affordable pays normally.

export type CostGate =
  | { ok: true; mode: ShortfallMode; activation: Activation; override: CostOverride | null; settle: (success: boolean) => Promise<void> }
  | { ok: false; status: number; body: Record<string, unknown> };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NOOP = async () => {};

/** What the cost routes need to know about a character: its name, campaign, that campaign's room code and its owner's active room. */
export async function loadCostCharacter(characterId: string) {
  const result = await query<{ name: string; campaign_id: string | null; room_code: string | null; active_vtt_session_id: string | null }>(
    `SELECT c.name, c.campaign_id, cp.room_code, u.active_vtt_session_id FROM characters c
     JOIN users u ON u.id = c.owner_user_id LEFT JOIN campaigns cp ON cp.id = c.campaign_id WHERE c.id = $1`, [characterId]);
  return result.rows[0] ?? null;
}

export async function openCostGate(input: {
  userId: string; characterId: string; activation: Activation;
  approvalId?: unknown; override?: unknown; roomId?: unknown; now?: number;
}): Promise<CostGate> {
  const approvalId = typeof input.approvalId === 'string' ? input.approvalId : '';
  const requested = input.override === 'dm' || input.override === 'self' ? input.override : null;
  // Nothing asked for and nothing else to learn: the plain path still needs a mode for a shortfall.
  const plain = (mode: ShortfallMode): CostGate => ({ ok: true, mode, activation: input.activation, override: null, settle: NOOP });
  if (!UUID.test(input.characterId)) return plain('no_dm');

  const access = await getCharacterAccess({ query }, input.userId, input.characterId);
  if (!access) return plain('no_dm');
  const row = await loadCostCharacter(input.characterId);
  if (!row) return plain('no_dm');

  const roomId = typeof input.roomId === 'string' && input.roomId.length <= 64 ? input.roomId : null;
  const room = resolveCostRoom({ userId: input.userId, roomId, ownerActiveRoomId: row.active_vtt_session_id, characterCampaignId: row.campaign_id, campaignRoomCode: row.room_code });
  // A bad room only matters when an override was asked for; a normal use must never break on it.
  const session = room.error ? null : room.session;
  if (room.error && (approvalId || requested)) return { ok: false, status: 403, body: { error: room.error } };

  const actorIsDm = isActorDm({ isCampaignDm: access.isCampaignDm, session, userId: input.userId, characterCampaignId: row.campaign_id });
  const present = session ? dmPresent(session) : false;
  const mode = shortfallMode({ actorIsDm, dmPresent: present });

  // --- An approval from the DM ---
  let claimed: { session: any; request: CostRequest } | null = null;
  if (approvalId) {
    const found = findCostRequest(approvalId);
    if (!found) return { ok: false, status: 409, body: { error: 'approval_invalid', reason: 'not_found', mode } };
    const verdict = approvalVerdict(found.request, {
      userId: input.userId, characterId: input.characterId, signature: activationSignature(input.activation), now: input.now
    });
    if (!verdict.ok) {
      if (verdict.reason === 'expired') closeCostRequest(found.session, found.request, 'expired');
      return { ok: false, status: 409, body: { error: 'approval_invalid', reason: verdict.reason, mode } };
    }
    claimApproval(found.request); // synchronous with the verdict above: no await in between
    claimed = found;
  }

  const decision = overrideDecision({ hasValidApproval: !!claimed, actorIsDm, dmPresent: present, requested });
  if (decision === 'forbidden') {
    return { ok: false, status: 403, body: { error: 'forbidden', message: 'Only the DM can go ahead over budget.', mode } };
  }

  type Used = Parameters<NonNullable<CostOverride['onUsed']>>[0];
  const box: { used: Used | null } = { used: null };
  let override: CostOverride | null = null;
  const onUsed: CostOverride['onUsed'] = (details) => { box.used = details; };
  const roomCode: string | null = (claimed?.session ?? session)?.id ?? null;
  if (decision === 'dm_approved' && claimed) {
    override = {
      kind: 'dm_approved', approvedByUserId: claimed.request.approvedBy ?? null, approvalRequestId: claimed.request.id,
      roomId: roomCode, waive: !!claimed.request.waive, onUsed
    };
  } else if (decision === 'dm_self' || decision === 'self_override') {
    override = { kind: decision, roomId: roomCode, onUsed };
  }
  // 'ask_dm' (a present DM must be asked properly) leaves override null: the shortfall comes back with mode.

  const settle = async (success: boolean) => {
    if (claimed) {
      if (success) closeCostRequest(claimed.session, claimed.request, 'used');
      else releaseApproval(claimed.request);
    }
    const details = box.used;
    if (!success || !details) return;
    // A self override also ends any request the player still had waiting (the DM left).
    if (details.kind === 'self_override' && session) {
      const pending = costMap(session)[input.characterId];
      if (pending && pending.playerId === input.userId && pending.status !== 'used') closeCostRequest(session, pending, 'withdrawn');
    }
    const logRoom = claimed?.session ?? session;
    if (!logRoom || !sessions.has(logRoom.id)) return;
    try {
      await logRoll(
        logRoom.id,
        overrideLogMessage({
          characterName: row.name, label: details.label, activation: input.activation, kind: details.kind,
          shortfalls: details.shortfalls, waived: details.waived, approvedByName: claimed?.request.approvedByName
        }),
        { kind: 'cost_override', overrideKind: details.kind, characterId: input.characterId, label: details.label, shortfalls: details.shortfalls, waived: details.waived },
        'public'
      );
    } catch (error) {
      // A log failure must never undo a payment that has already been committed.
      console.error('[cost] could not write the roll-log line', error);
    }
  };

  return { ok: true, mode, activation: input.activation, override, settle };
}

/** The 409 body for a shortfall, with the prompt mode the client should show. */
export function costShortfallBody(gate: Extract<CostGate, { ok: true }>, error: CostShortfallError) {
  // `activation` is exactly what the server will check an approval against, so a client asks with it as it is.
  return { error: 'insufficient', message: error.message, shortfalls: error.shortfalls, mode: gate.mode, activation: gate.activation };
}

/**
 * Runs a cost-paying action under the gate: settles it (claimed approval used or released, the
 * roll-log line posted) whatever happens, and rethrows. A CostShortfallError still reaches the caller.
 */
export async function runWithGate<T>(gate: Extract<CostGate, { ok: true }>, run: (override: CostOverride | null) => Promise<T>): Promise<T> {
  let result: T;
  try {
    result = await run(gate.override);
  } catch (error) {
    await gate.settle(false);
    throw error;
  }
  await gate.settle(true);
  return result;
}
