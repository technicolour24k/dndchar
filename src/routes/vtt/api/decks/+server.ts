import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isUuid } from '$lib/server/services/access';
import { listDecksForCharacter, listDrawsForCampaign, listOpenDmTasks } from '$lib/server/services/decks';
import { badInput, deckErrorResponse } from '$lib/server/vttDeckApi';

// Decks (decks plan, unit 5). One API for the sheet and the VTT. Every call goes through the deck service,
// which does the access check; nothing here trusts a client-supplied target or value.
//   GET ?characterId=<id>            decks the character's campaign has enabled, an undecided draw, recent draws
//   GET ?campaignId=<id>             the campaign's draw log (members); add &tasks=1 for the DM's open tasks (DM only)
export const GET: RequestHandler = async ({ locals, url }) => {
  const userId = locals.user!.id;
  const characterId = url.searchParams.get('characterId');
  const campaignId = url.searchParams.get('campaignId');
  try {
    if (characterId) {
      if (!isUuid(characterId)) return badInput('Bad character id.');
      return json(await listDecksForCharacter(userId, characterId));
    }
    if (campaignId) {
      if (!isUuid(campaignId)) return badInput('Bad campaign id.');
      if (url.searchParams.get('tasks') === '1') return json({ tasks: await listOpenDmTasks(userId, campaignId) });
      return json({ draws: await listDrawsForCampaign(userId, campaignId) });
    }
    return badInput('characterId or campaignId is required.');
  } catch (error) {
    return deckErrorResponse(error);
  }
};
