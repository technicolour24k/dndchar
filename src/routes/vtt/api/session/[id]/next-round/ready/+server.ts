import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions } from '$vtt/store.js';
import { playerSignal } from '$lib/server/vttNextRound';

// A player's answer to a pending round: { action: 'ready' } or { action: 'hold' } ("Hold on" tells the GM
// they want to act first). Who is asking comes from the signed-in account (locals.user), never from the
// body, and only a player the round is waiting on can change anything (else 409 not_expected). The GM
// uses the next-round route instead. Nothing about other players is ever returned.
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const session = sessions.get(params.id!);
  if (!session) return json({ error: 'session_not_found' }, { status: 404 });

  const body = await request.json().catch(() => ({}));
  if (body?.action !== 'ready' && body?.action !== 'hold') return json({ error: 'invalid_action' }, { status: 400 });

  const outcome = await playerSignal(session, locals.user!.id, body.action, body.pendingId);
  return json(outcome.body, { status: outcome.status });
};
