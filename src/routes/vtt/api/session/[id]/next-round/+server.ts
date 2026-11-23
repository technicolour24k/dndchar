import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions } from '$vtt/store.js';
import { isRoomGm } from '$lib/server/vttForage';
import { cancelRound, requestRound, startRound } from '$lib/server/vttNextRound';

// The room GM's table-wide round. Room GM only (isRoomGm). It does not process on the first press any
// more: it asks for the round, which then waits for the players (see src/lib/server/vttNextRound.ts).
//
//   { action: 'request' }  open a pending round (processes at once if nobody is expected). The default.
//   { action: 'start' }    process the pending round now, ready or not.
//   { action: 'cancel' }   drop the pending round, nothing processed.
//
// Answers 409 already_pending / too_soon / no_pending for the obvious races. A processed round answers
// { advanced, skipped, views }; the same result also goes to the GM socket as round:done.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const session = sessions.get(params.id!);
  if (!session) return json({ error: 'session_not_found' }, { status: 404 });
  if (!isRoomGm(session, locals.user!.id)) return json({ error: 'not_gm' }, { status: 403 });

  const body = await request.json().catch(() => ({}));
  const action = body?.action ?? 'request';
  if (action !== 'request' && action !== 'start' && action !== 'cancel') return json({ error: 'invalid_action' }, { status: 400 });

  const outcome = action === 'request' ? await requestRound(session, locals.user!.id) : action === 'start' ? await startRound(session, locals.user!.id) : cancelRound(session);
  return json(outcome.body, { status: outcome.status });
};
