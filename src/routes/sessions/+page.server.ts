import { fail } from '@sveltejs/kit';
import { createGameSession, joinGameSession, listGameSessionsForUser } from '$lib/server/services/gameSessions';

export async function load({ locals }) {
  return { sessions: await listGameSessionsForUser(locals.user!.id) };
}

export const actions = {
  create: async ({ request, locals }) => {
    const form = await request.formData();
    await createGameSession(locals.user!.id, String(form.get('name') || ''));
    return { created: true };
  },
  join: async ({ request, locals }) => {
    const form = await request.formData();
    const gameSessionId = String(form.get('gameSessionId') || '').trim();
    if (!gameSessionId) return fail(400, { joinError: 'Enter a session ID.' });
    try {
      await joinGameSession(locals.user!.id, gameSessionId);
    } catch {
      return fail(400, { joinError: 'That session ID was not found or is not active.' });
    }
    return { joined: true };
  }
};
