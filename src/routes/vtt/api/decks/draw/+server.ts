import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isUuid } from '$lib/server/services/access';
import { drawCard } from '$lib/server/services/decks';
import { announceDeck } from '$lib/server/vttDeckAnnounce';
import { badInput, deckErrorResponse } from '$lib/server/vttDeckApi';

// POST { characterId, deckId }. The card, the success and the targets are all decided server-side. An Ace comes
// back 'choosing' with nothing applied (finish it with .../choose); anything else resolves and is announced.
export const POST: RequestHandler = async ({ locals, request }) => {
  const body = await request.json().catch(() => ({}));
  if (!isUuid(body?.characterId) || !isUuid(body?.deckId)) return badInput('characterId and deckId are required.');
  try {
    const result = await drawCard({ userId: locals.user!.id, characterId: body.characterId, deckId: body.deckId });
    if (result.status === 'resolved') await announceDeck(result.draw, 'drawn');
    return json(result);
  } catch (error) {
    return deckErrorResponse(error);
  }
};
