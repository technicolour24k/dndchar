import { json } from '@sveltejs/kit';
import { getActiveGameSessionForUser, getGameSession, joinGameSession } from '$lib/server/services/gameSessions';

// Backs SessionNotesModal.svelte - unlike the old /sessions/[id] page, the
// modal can be opened from any page (the /sessions list, the character
// sheet, or this route itself for direct links), so it needs its own JSON
// endpoint rather than a page-scoped load()/action pair.
export async function GET({ params, locals }) {
  const gameSession = await getGameSession(params.id!);
  if (!gameSession) return json({ error: 'not_found' }, { status: 404 });

  const joined = (await getActiveGameSessionForUser(locals.user!.id)) === params.id;
  return json({ gameSession, joined });
}

export async function POST({ params, locals }) {
  try {
    await joinGameSession(locals.user!.id, params.id!);
  } catch {
    return json({ error: 'not_found_or_inactive' }, { status: 400 });
  }
  return json({ joined: true });
}
