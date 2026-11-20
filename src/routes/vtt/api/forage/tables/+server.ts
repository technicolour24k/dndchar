import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions } from '$vtt/store.js';
import { SKILL_CHECKS } from '$lib/rules/skills';
import { listSuggestedChecks, loadForageCatalogue } from '$lib/server/services/forage';
import { isRoomGm } from '$lib/server/vttForage';
import { shortText } from '$lib/server/vttForageApi';

// The pickers' data for both forage popups: the 18 skills and every active table (player-safe
// fields only). GET /vtt/api/forage/tables[?roomId=<code>]
//
// suggestedCheck (it usually holds the DC) is added ONLY when roomId is a live room and the caller is
// that room's GM (Q9). Players, and a GM with no room, never receive it.
export const GET: RequestHandler = async ({ locals, url }) => {
  const catalogue = await loadForageCatalogue();

  const session = sessions.get(shortText(url.searchParams.get('roomId'), 64));
  const suggested = session && isRoomGm(session, locals.user!.id) ? await listSuggestedChecks() : null;

  return json({
    skills: SKILL_CHECKS,
    tables: catalogue.tables.map((table) => ({
      id: table.id,
      name: table.name,
      areaType: table.areaType,
      category: table.category,
      typeDie: table.typeDie,
      pickableCount: table.pickableCount,
      ...(suggested ? { suggestedCheck: suggested.get(table.id) ?? '' } : {})
    }))
  });
};
