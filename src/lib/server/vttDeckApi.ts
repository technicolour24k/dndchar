import { json } from '@sveltejs/kit';
import { DeckError, type DeckErrorCode } from '$lib/server/services/decks';

// Small helpers shared by the deck HTTP endpoints. Errors always come back as { error, message }.
const STATUS: Record<DeckErrorCode, number> = {
  bad_input: 400, forbidden: 403, not_found: 404, choosing: 409, not_enabled: 409, already_undone: 409, not_choosing: 409
};

export function deckErrorResponse(error: unknown): Response {
  if (error instanceof DeckError) {
    return json({ error: error.code, message: error.message, ...(error.draw ? { draw: error.draw } : {}) }, { status: STATUS[error.code] });
  }
  console.error('[decks] request failed', error);
  return json({ error: 'server_error', message: 'Something went wrong.' }, { status: 500 });
}

export const badInput = (message: string) => json({ error: 'bad_input', message }, { status: 400 });
