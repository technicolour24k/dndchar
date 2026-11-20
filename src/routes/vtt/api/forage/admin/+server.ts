import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { announceUndo, publishFindChanged } from '$lib/server/vttForageRoll';
import { clearUnmarkedCheck, listUnmarkedChecks, revertFind } from '$lib/server/services/forage';
import { isUuid } from '$lib/server/vttForageApi';

// Admin-only forage endpoint (the /admin/forage page uses the same services directly). Admin is the de facto DM
// until campaigns exist (Q7), so only role 'admin' may call it.
//
//   GET                                   unmarked self-serve checks, newest first (to find a stuck one)
//   POST { action: 'clear', findId }      closes a stuck unmarked check as failed, so the player can forage again
//   POST { action: 'undo', findId }       reverts a found haul (either mode): reduces or removes the rows it
//                                         wrote, notes anything already used or removed, keeps the find as 'reverted'

const forbidden = () => json({ error: 'forbidden' }, { status: 403 });

export const GET: RequestHandler = async ({ locals }) => {
  if (locals.user!.role !== 'admin') return forbidden();
  return json({ unmarked: await listUnmarkedChecks() });
};

export const POST: RequestHandler = async ({ locals, request }) => {
  if (locals.user!.role !== 'admin') return forbidden();
  const body = await request.json().catch(() => ({}));
  if (!isUuid(body?.findId)) return json({ error: 'not_found' }, { status: 404 });

  if (body.action === 'clear') {
    const cleared = await clearUnmarkedCheck(body.findId);
    if (!cleared) return json({ error: 'not_found' }, { status: 404 });
    publishFindChanged(cleared.gameSessionId, body.findId);
    return json({ ok: true });
  }

  if (body.action === 'undo') {
    const reverted = await revertFind({ findId: body.findId, adminUserId: locals.user!.id });
    if (!reverted) return json({ error: 'not_found' }, { status: 404 });
    await announceUndo(reverted, body.findId);
    return json({ ok: true, note: reverted.note });
  }

  return json({ error: 'invalid_action' }, { status: 400 });
};
