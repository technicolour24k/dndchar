import { json } from '@sveltejs/kit';
import { sessions, broadcast } from '$vtt/store.js';
import { createGameSession, endGameSession } from '$lib/server/services/gameSessions';

// Start/End Session for Session Notes - mirrors ../combat/+server.ts exactly,
// just against game_sessions instead of encounters. Independent of Start/Stop
// Combat: a Game Session is meant to span the whole night, not just a fight.
export async function POST({ request, params, locals }) {
  const session = sessions.get(params.id!);
  if (!session) return json({ error: 'session_not_found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  const action = body?.action;

  if (action === 'start') {
    const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim() : `Session - room ${params.id}`;
    const gameSessionId = await createGameSession(locals.user!.id, name);
    session.gameSessionId = gameSessionId;
    broadcast(params.id!, () => ({ type: 'game_session:state', active: true, gameSessionId, name }));
    return json({ gameSessionId });
  }

  if (action === 'stop') {
    if (session.gameSessionId) {
      await endGameSession(locals.user!.id, session.gameSessionId);
    }
    session.gameSessionId = null;
    broadcast(params.id!, () => ({ type: 'game_session:state', active: false, gameSessionId: null }));
    return json({ ok: true });
  }

  return json({ error: 'invalid_action' }, { status: 400 });
}
