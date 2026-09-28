import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { listEncountersForCharacter } from '$lib/server/services/encounters';
import { listGameSessionsForUser } from '$lib/server/services/gameSessions';

// db-traffic-reduction Phase 4: Past Encounters / Past Sessions used to ship in every
// sheet load() purely for the (rarely-opened) Activity Log modal's history tabs. Fetched
// only when that modal actually opens, instead. listEncountersForCharacter() takes a bare
// characterId with no owner check of its own (unlike listVersions) - the old load() was
// safe because getCharacter() had already confirmed ownership earlier in the same
// request, so this route does that same minimal ownership check itself before calling it.
// listGameSessionsForUser() is already user-scoped (a player's own joined sessions across
// every character), so it needs no character-specific check at all.
export const GET: RequestHandler = async ({ params, locals }) => {
  const owned = await query('SELECT 1 FROM characters WHERE id = $1 AND owner_user_id = $2', [params.id, locals.user!.id]);
  if (!owned.rowCount) throw error(404, 'Character not found.');

  const [encounterHistory, gameSessionHistory] = await Promise.all([
    listEncountersForCharacter(params.id!),
    listGameSessionsForUser(locals.user!.id)
  ]);

  return json({ encounterHistory, gameSessionHistory });
};
