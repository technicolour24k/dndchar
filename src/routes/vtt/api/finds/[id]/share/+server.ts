import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { shareFind } from '$lib/server/services/forage';
import { announceShare } from '$lib/server/vttForageRoll';

// POST /vtt/api/finds/[id]/share - the finder shares a standing find with the party.
//
// One way (there is no unshare). Owner-checked: only the finder or the character's owner. Failed and
// reverted finds can't be shared (409 not_shareable). Sharing twice answers 200 again with no second
// roll-log line. The VTT result card calls this, and so will the character sheet's result.
//   200 { ok: true, shared: true }
//   403 forbidden, 404 not_found, 409 not_shareable
export const POST: RequestHandler = async ({ locals, params }) => {
  const outcome = await shareFind(params.id, locals.user!.id);
  if (!outcome.ok) {
    const status = outcome.error === 'forbidden' ? 403 : outcome.error === 'not_found' ? 404 : 409;
    return json({ error: outcome.error }, { status });
  }
  if (!outcome.alreadyShared) await announceShare(outcome.find);
  return json({ ok: true, shared: true });
};
