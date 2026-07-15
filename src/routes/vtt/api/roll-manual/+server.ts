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
  return json(result);
};
