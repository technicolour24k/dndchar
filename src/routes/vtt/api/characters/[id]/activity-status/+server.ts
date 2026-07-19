import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCharacter } from '$lib/server/services/characters';
import { getActiveEncounterForCharacter } from '$lib/server/services/encounters';
import { getRoomGameSessionId } from '$lib/server/services/gameSessions';

// activeEncounterId/activeGameSessionId are otherwise only computed at
// load()-time (SSR) - if a GM starts combat or a game session *after* a
// player already has their character sheet open, nothing re-derives those
// values until a full page reload. This lets the Activity Log modal poll for
// the current live state instead, ownership-scoped exactly like the sibling
// GET /vtt/api/characters/[id] route.
export const GET: RequestHandler = async ({ locals, params }) => {
  const character = await getCharacter(locals.user!.id, params.id!);
  if (!character) return json({ error: 'not_found' }, { status: 404 });

  return json({
    encounterId: await getActiveEncounterForCharacter(params.id!),
    gameSessionId: await getRoomGameSessionId(locals.user!.id)
  });
};
