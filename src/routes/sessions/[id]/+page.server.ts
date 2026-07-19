import { error, fail } from '@sveltejs/kit';
import { getActiveGameSessionForUser, getGameSession, joinGameSession, listSessionNotes, logSessionNote } from '$lib/server/services/gameSessions';

export async function load({ params, locals }) {
  const gameSession = await getGameSession(params.id);
  if (!gameSession) throw error(404, 'Session not found.');

  return {
    gameSession,
    notes: await listSessionNotes(params.id),
    joined: (await getActiveGameSessionForUser(locals.user!.id)) === params.id
  };
}

export const actions = {
  join: async ({ params, locals }) => {
    try {
      await joinGameSession(locals.user!.id, params.id);
    } catch {
      return fail(400, { joinError: 'This session is not active.' });
    }
    return { joined: true };
  },
  post: async ({ request, params, locals }) => {
    const form = await request.formData();
    const message = String(form.get('message') || '').trim();
    if (!message) return fail(400, { postError: 'Nothing to post.' });
    try {
      await logSessionNote(params.id, locals.user!.id, message);
    } catch {
      return fail(400, { postError: 'This session is not active.' });
    }
    return { posted: true };
  }
};
