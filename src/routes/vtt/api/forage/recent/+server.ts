import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listRecentFindsForCharacter } from '$lib/server/services/forage';
import { loadOwnedCharacter } from '$lib/server/vttForageApi';

// "My recent finds": the owner's last few found (and undone) finds, so a find can still be shared
// after its result card has been dismissed (a self-serve find with no game session has no other way).
// GET /vtt/api/forage/recent?characterId=<id>
//
// Owner-checked (404 for anyone else's character). Per Rev 4 it carries no table name, table id or
// suggested check: just items, quantities, mode, shared flag, time and the undo note.
export const GET: RequestHandler = async ({ locals, url }) => {
  const owned = await loadOwnedCharacter(locals.user!.id, url.searchParams.get('characterId'));
  if (!owned) return json({ error: 'not_found' }, { status: 404 });
  return json({ finds: await listRecentFindsForCharacter(url.searchParams.get('characterId')!) });
};
