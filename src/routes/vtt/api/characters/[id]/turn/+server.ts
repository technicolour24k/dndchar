import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { withTransaction } from '$lib/server/db';
import { getCharacterAccess } from '$lib/server/services/access';
import { payTurnActivation } from '$lib/server/services/catalogue';
import { adjustTurnPool, getTurnView, resetTurnState, lockTurnState } from '$lib/server/services/turn-state';
import { trimTurnView } from '$lib/server/vttTurn';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { CostShortfallError, FollowupGoneError } from '$lib/server/services/cost-engine';
import { costShortfallBody, openCostGate, runWithGate } from '$lib/server/vttCostGate';
import { parseActivation } from '$lib/server/vttCostApproval';

// A character's per-turn actions from the VTT (action economy). Three actions:
//   pay    - spend an action that has no sheet row behind it: an id-less weapon attack (Unarmed Strike,
//            a GM-added action on a PC token) or a dash. Same gate as every cost: a shortfall is a 409
//            'insufficient' the client turns into the ask-the-DM prompt. Needs act access.
//   reset  - a fresh turn for this character (bookkeeping: edit access).
//   adjust - manual +/- on a pool (bookkeeping: edit access).
// Every success tells open sheets and tokens to re-sync.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const characterId = params.id!;
  const body = await request.json().catch(() => ({}));
  const access = await getCharacterAccess({ query }, locals.user!.id, characterId);
  if (!access) return json({ error: 'not_found' }, { status: 404 });

  if (body?.action === 'pay') {
    if (!access.canAct) return json({ error: 'not_found' }, { status: 404 });
    const activation = parseActivation(body.activation);
    // Only what the sheet cannot pay for itself: an id-less weapon attack, or a dash.
    if (!activation || !((activation.kind === 'weapon_attack' && !activation.inventoryId) || activation.kind === 'dash')) {
      return json({ error: 'bad_activation' }, { status: 400 });
    }
    const gate = await openCostGate({ userId: locals.user!.id, characterId, activation, approvalId: body.approvalId, override: body.override, roomId: body.roomId });
    if (!gate.ok) return json(gate.body, { status: gate.status });
    try {
      const paid = await runWithGate(gate, (override) => payTurnActivation(locals.user!.id, characterId, activation, override));
      emitRealtimeEvent('resource:changed', { characterId });
      // The same follow-up fields as roll-attack's `turn` (the trimmed view stays under `turn`, as for a dash),
      // so the client can word "Paid: ..." / "Extra Attack (N left)" the same either way.
      const used = paid.paid.find((line) => line.pool === 'followup');
      const followupCls = activation.kind === 'weapon_attack' && (activation.timing ?? 'action') === 'action' ? 'melee' : null;
      return json({
        paid: paid.paid.map((line) => ({ label: line.label, delta: line.delta })), view: paid.turn, turn: trimTurnView(paid.turn),
        usedFollowup: Boolean(used), followupCls, followupsLeft: (paid.turn.followups ?? []).map((f) => ({ cls: f.cls, label: f.label, remaining: f.remaining }))
      });
    } catch (error) {
      if (error instanceof CostShortfallError) return json(costShortfallBody(gate, error), { status: 409 });
      if (error instanceof FollowupGoneError) return json({ error: 'followup_gone', message: error.message }, { status: 409 });
      return json({ error: error instanceof Error ? error.message : 'Could not pay for that.' }, { status: 400 });
    }
  }

  if (!access.canEdit) return json({ error: 'not_found' }, { status: 404 });

  if (body?.action === 'reset') {
    await withTransaction(async (client) => {
      await lockTurnState(client, characterId); // the turn row is the first lock
      await resetTurnState(client, characterId, 'Turn reset from the VTT');
    });
    emitRealtimeEvent('resource:changed', { characterId });
    const view = await getTurnView({ query }, characterId);
    return json({ view, turn: trimTurnView(view) });
  }

  if (body?.action === 'adjust') {
    try {
      const view = await adjustTurnPool(locals.user!.id, characterId, typeof body.key === 'string' ? body.key : '', Number(body.delta));
      emitRealtimeEvent('resource:changed', { characterId });
      return json({ view, turn: trimTurnView(view) });
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : 'Could not change that.' }, { status: 400 });
    }
  }

  return json({ error: 'bad_action' }, { status: 400 });
};
