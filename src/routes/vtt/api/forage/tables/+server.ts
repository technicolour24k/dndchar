import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions } from '$vtt/store.js';
import { FORAGE_SELF_SKILLS, SKILL_CHECKS } from '$lib/rules/skills';
import { listSuggestedChecks, loadForageCatalogue } from '$lib/server/services/forage';
import { isRoomGm } from '$lib/server/vttForage';
import { shortText } from '$lib/server/vttForageApi';

// The pickers' data for both forage popups. GET /vtt/api/forage/tables[?roomId=<code>]
//
//   The room's GM (roomId is a live room and the caller is its GM): the 18 skills and every active
//   table with its name, counts and suggestedCheck, because the DM picks the table (Q9, Rev 4).
//   Everyone else: ONLY what a self-serve player needs. The short skill list, and the area + category
//   pairs that have something pickable, as plain tags. No table names, ids, counts or suggestedCheck.
export const GET: RequestHandler = async ({ locals, url }) => {
  const catalogue = await loadForageCatalogue();

  const session = sessions.get(shortText(url.searchParams.get('roomId'), 64));
  if (!(session && isRoomGm(session, locals.user!.id))) {
    const seen = new Set<string>();
    const options: Array<{ areaType: string; category: string }> = [];
    for (const table of catalogue.tables) {
      const key = `${table.areaType}|${table.category}`;
      if (table.pickableCount > 0 && !seen.has(key)) {
        seen.add(key);
        options.push({ areaType: table.areaType, category: table.category });
      }
    }
    return json({
      skills: SKILL_CHECKS.filter((skill) => FORAGE_SELF_SKILLS.includes(skill.key)).map((skill) => ({ key: skill.key, name: skill.name })),
      options
    });
  }

  const suggested = await listSuggestedChecks();
  return json({
    skills: SKILL_CHECKS,
    tables: catalogue.tables.map((table) => ({
      id: table.id,
      name: table.name,
      areaType: table.areaType,
      category: table.category,
      typeDie: table.typeDie,
      pickableCount: table.pickableCount,
      suggestedCheck: suggested.get(table.id) ?? ''
    }))
  });
};
