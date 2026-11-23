import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { chooseValue } from '$lib/server/services/decks';
import { announceDeck } from '$lib/server/vttDeckAnnounce';
import { badInput, deckErrorResponse } from '$lib/server/vttDeckApi';

// POST { value }: the drawer's Ace choice (the only client value that is used; the service checks it is one
// of the card's options).
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const body = await request.json().catch(() => ({}));
  if (!Number.isInteger(body?.value)) return badInput('value must be a whole number.');
  try {
    const draw = await chooseValue({ userId: locals.user!.id, drawId: params.id, value: body.value });
    await announceDeck(draw, 'drawn');
    return json({ status: 'resolved', draw });
  } catch (error) {
    return deckErrorResponse(error);
  }
};
