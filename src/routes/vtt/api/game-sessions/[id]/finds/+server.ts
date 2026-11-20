import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listFindsForGameSession } from '$lib/server/services/forage';

// GET /vtt/api/game-sessions/[id]/finds - the Finds section of Session Notes, shaped for the caller.
// The server decides what each viewer may see: full rows for the Game Session owner (or an admin),
// for the finder, and for any find that was shared; everyone else gets a one-line count with no
// names (see shapeFindForViewer). Live updates reach the modal as a detail-free
// game_session:find nudge, after which the modal calls this again.
export const GET: RequestHandler = async ({ locals, params }) => {
  const result = await listFindsForGameSession(params.id, { id: locals.user!.id, role: locals.user!.role });
  if (!result) return json({ error: 'not_found' }, { status: 404 });
  return json({ ...result, isAdmin: locals.user!.role === 'admin' });
};
