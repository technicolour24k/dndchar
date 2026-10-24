import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { rollManualAttack } from '$lib/rules/attackRoll';

// Server-side roll for a DM's manual stat-block attack (a monster's action:
// name + to-hit bonus + damage dice, entered directly on the token, no linked
// character). Kept server-side purely so the VTT reuses the one shared roll
// module and its display format - the vanilla client can't import $lib. The
// route is auth-gated by hooks.server.ts; GM-only enforcement of *who* may
// attack lives in the VTT socket layer (attack:resolve), not here - this
// endpoint only rolls dice and reveals nothing sensitive.
export const POST: RequestHandler = async ({ request }) => {
  const body = await request.json().catch(() => ({}));
  const result = rollManualAttack({
    name: String(body?.name || 'Attack'),
    toHitBonus: Number(body?.toHitBonus) || 0,
    damageRolls: String(body?.damageRolls || ''),
    damageBonus: Number(body?.damageBonus) || 0
  });

  // A manual stat-block spell (kind 'spell' on the token's action) - same
  // result shape as roll-spell so the VTT's spell flow needs no special case.
  // Only 'attack' resolution has a to-hit roll; save/auto spells drop it and
  // carry the fixed DC instead.
  const damageType = String(body?.damageType || '').trim().toLowerCase() || undefined;
  const resolution = body?.resolution;
  if (resolution === 'attack' || resolution === 'save' || resolution === 'auto') {
    if (resolution === 'attack') return json({ ...result, resolution, damageType });
    const { attack, attackTotal, attackNatural, outcomes, ...rest } = result;
    void attack; void attackTotal; void attackNatural; void outcomes;
    return json({
      ...rest,
      resolution,
      damageType,
      outcomes: [],
      saveDc: resolution === 'save' ? Number(body?.saveDc) || 10 : undefined,
      saveAbility: resolution === 'save' ? String(body?.saveAbility || 'dex') : undefined,
      saveEffect: resolution === 'save' ? (body?.saveEffect === 'negate' ? 'negate' : 'half') : undefined
    });
  }
  return json({ ...result, damageType });
};
