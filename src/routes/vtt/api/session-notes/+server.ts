import { json } from '@sveltejs/kit';
import { logSessionNote, listSessionNotes } from '$lib/server/services/gameSessions';

// Posting is always a plain, already-authenticated browser request - the VTT
// static client, the character sheet, and the /sessions pages all call this
// directly via fetch() with a real session cookie. Unlike the combat log,
// vtt/server's ws process never needs to originate a note itself, so there's
// no internal-secret bridge here - this route stays behind the normal
// hooks.server.ts locals.user gate like any other route.
export async function POST({ request, locals }) {
  const body = await request.json().catch(() => ({}));
  const gameSessionId = typeof body?.gameSessionId === 'string' ? body.gameSessionId : '';
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!gameSessionId || !message) return json({ error: 'missing_fields' }, { status: 400 });

  try {
    const note = await logSessionNote(gameSessionId, locals.user!.id, message);
    return json(note);
  } catch {
    return json({ error: 'session_not_found_or_inactive' }, { status: 400 });
  }
}

export async function GET({ url }) {
  const gameSessionId = url.searchParams.get('gameSessionId') || '';
  const afterId = url.searchParams.get('afterId') || undefined;
  if (!gameSessionId) return json({ error: 'missing_game_session_id' }, { status: 400 });

  const notes = await listSessionNotes(gameSessionId, afterId);
  return json({ notes });
}
