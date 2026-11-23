import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { revertDraw } from '$lib/server/services/decks';
import { announceDeck } from '$lib/server/vttDeckAnnounce';
import { deckErrorResponse } from '$lib/server/vttDeckApi';

// POST: the campaign DM / co-DM (or site admin) undoes a draw. An undecided Ace is cancelled (nothing to announce).
export const POST: RequestHandler = async ({ locals, params }) => {
  try {
    const draw = await revertDraw({ userId: locals.user!.id, drawId: params.id });
    if (draw.status === 'reverted') await announceDeck(draw, 'undone');
    return json({ draw });
  } catch (error) {
    return deckErrorResponse(error);
  }
};
