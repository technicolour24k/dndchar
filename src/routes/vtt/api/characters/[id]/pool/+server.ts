import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCharacter } from '$lib/server/services/characters';
import { adjustCharacterPool } from '$lib/server/services/resource-pools';
import { emitRealtimeEvent } from '$lib/server/realtime';

// Manual +/- on one of the character's resource pools from the VTT mini-sheet (cost-engine plan,
// Unit 7). The same free bookkeeping as the sheet's poolAdjust action: whoever can EDIT the sheet (the
// owner, the campaign DM/co-DM, or the site admin) may do it, it is clamped 0..max server-side and
// logged as a 'manual' ledger row. Answers with the character's current pools so the client can show
// them without another round trip. POST { key, delta }
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const characterId = params.id!;
  const body = await request.json().catch(() => ({}));
  const key = typeof body?.key === 'string' ? body.key : '';
  const delta = Number(body?.delta);
  if (!key || !Number.isInteger(delta) || delta === 0 || Math.abs(delta) > 99) return json({ error: 'bad_request' }, { status: 400 });

  try {
    await adjustCharacterPool(locals.user!.id, characterId, key, delta);
  } catch (error) {
    // assertCanEditCharacter throws the same message for "no such character" and "not yours".
    const message = error instanceof Error ? error.message : '';
    if (message === 'Unknown resource pool.') return json({ error: 'unknown_pool' }, { status: 400 });
    return json({ error: 'not_found' }, { status: 404 });
  }
  emitRealtimeEvent('resource:changed', { characterId });

  const character = await getCharacter(locals.user!.id, characterId);
  if (!character) return json({ error: 'not_found' }, { status: 404 });
  return json({ pools: character.pools.map(({ key, label, current, max, rechargePeriod }) => ({ key, label, current, max, rechargePeriod })) });
};
