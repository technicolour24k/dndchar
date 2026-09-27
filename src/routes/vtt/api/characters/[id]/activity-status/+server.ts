import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { getActiveEncounterForCharacter } from '$lib/server/services/encounters';
import { getRoomGameSessionId } from '$lib/server/services/gameSessions';

// activeEncounterId/activeGameSessionId are otherwise only computed at
// load()-time (SSR) - if a GM starts combat or a game session *after* a
// player already has their character sheet open, nothing re-derives those
// values until a full page reload. This lets the Activity Log modal poll for
// the current live state instead, ownership-scoped exactly like the sibling
// GET /vtt/api/characters/[id] route.
//
// Ownership check is a bare single-row lookup, deliberately NOT getCharacter -
// that builds the entire computed sheet (~15 queries, every effect definition,
// all content), and this endpoint is polled on a timer by every open sheet.
export const GET: RequestHandler = async ({ locals, params }) => {
  const owned = await query('SELECT 1 FROM characters WHERE id = $1 AND owner_user_id = $2', [params.id!, locals.user!.id]);
  if (!owned.rowCount) return json({ error: 'not_found' }, { status: 404 });

  return json({
    encounterId: await getActiveEncounterForCharacter(params.id!),
    gameSessionId: await getRoomGameSessionId(locals.user!.id)
  });
};
