import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions } from '$vtt/store.js';
import { FORAGE_SELF_SKILLS, SKILL_CHECKS } from '$lib/rules/skills';
import { DEFAULT_FORAGE_CATEGORIES, tablesForCampaign } from '$lib/rules/forage';
import { listSuggestedChecks, loadForageCatalogue } from '$lib/server/services/forage';
import { isRoomGm } from '$lib/server/vttForage';
import { loadOwnedCharacter, shortText } from '$lib/server/vttForageApi';

// The pickers' data for both forage popups. GET /vtt/api/forage/tables[?roomId=<code>][&characterId=<id>]
// Find tables belong to a campaign (Unit G), so everything here is one campaign's tables.
//
//   The room's GM (roomId is a live room and the caller is its GM): the 18 skills and every active
//   table OF THE ROOM'S CAMPAIGN with its name, counts and suggestedCheck, because the DM picks the
//   table (Q9, Rev 4). A Quick room has no campaign, so it gets no tables and unavailableReason
//   'wrong_room'.
//   Everyone else: ONLY what a self-serve player needs. The short skill list, every area tag the
//   character's campaign tables use, and the categories (the defaults plus any those tables use), as
//   two separate lists of plain tags. The character comes from ?characterId= (owner-checked); with
//   none, or one that isn't yours, the lists are empty. Never pairs, and empty tables count too, so
//   the lists say nothing about which combinations have something to find. No table names, ids,
//   counts or suggestedCheck.
export const GET: RequestHandler = async ({ locals, url }) => {
  const catalogue = await loadForageCatalogue();

  const session = sessions.get(shortText(url.searchParams.get('roomId'), 64));
  if (!(session && isRoomGm(session, locals.user!.id))) {
    const owned = await loadOwnedCharacter(locals.user!.id, url.searchParams.get('characterId'));
    const own = tablesForCampaign(catalogue.tables, owned?.campaignId);
    const areas = [...new Set(own.map((table) => table.areaType))].sort();
    const categories = [...new Set([...DEFAULT_FORAGE_CATEGORIES, ...own.map((table) => table.category)])].sort();
    return json({
      skills: SKILL_CHECKS.filter((skill) => FORAGE_SELF_SKILLS.includes(skill.key)).map((skill) => ({ key: skill.key, name: skill.name })),
      areas,
      categories
    });
  }

  // A Quick room has no campaign, so it has no find tables.
  if (!session.campaignId) return json({ skills: SKILL_CHECKS, tables: [], unavailableReason: 'wrong_room' });
  const suggested = await listSuggestedChecks(session.campaignId);
  return json({
    skills: SKILL_CHECKS,
    tables: tablesForCampaign(catalogue.tables, session.campaignId).map((table) => ({
      id: table.id,
      name: table.name,
      areaType: table.areaType,
      category: table.category,
      pickableCount: table.pickableCount,
      suggestedCheck: suggested.get(table.id) ?? ''
    }))
  });
};
