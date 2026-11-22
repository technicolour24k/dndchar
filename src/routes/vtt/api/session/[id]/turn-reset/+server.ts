import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sessions } from '$vtt/store.js';
import { query, withTransaction } from '$lib/server/db';
import { isRoomGm } from '$lib/server/vttForage';
import { getCharacterAccess } from '$lib/server/services/access';
import { getTurnView, lockTurnState, resetTurnState } from '$lib/server/services/turn-state';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { trimTurnView } from '$lib/server/vttTurn';

// The room GM's "Reset all" also gives every character on the map a fresh turn (action economy
// Unit 5). The VTT server has no database, so this is the HTTP half of the socket's
// token:move:resetAll. Room GM only (isRoomGm). Each distinct character is reset only where the
// caller may edit it (campaign DM or site admin; a Quick-room GM who does not own a sheet skips it).
// Answers { reset, skipped, views } where views maps characterId to the trimmed token.turn copy.
export const POST: RequestHandler = async ({ locals, params }) => {
  const session = sessions.get(params.id!);
  if (!session) return json({ error: 'session_not_found' }, { status: 404 });
  if (!isRoomGm(session, locals.user!.id)) return json({ error: 'not_gm' }, { status: 403 });

  const ids = [...new Set(Object.values<any>(session.tokens ?? {}).map((token) => token.characterId).filter((id): id is string => typeof id === 'string' && id.length > 0))];
  const views: Record<string, unknown> = {};
  let skipped = 0;
  for (const characterId of ids) {
    const access = await getCharacterAccess({ query }, locals.user!.id, characterId).catch(() => null);
    if (!access?.canEdit) { skipped += 1; continue; }
    await withTransaction(async (client) => {
      await lockTurnState(client, characterId); // the turn row is the first lock
      await resetTurnState(client, characterId, 'Turn reset from the VTT');
    });
    emitRealtimeEvent('resource:changed', { characterId });
    views[characterId] = trimTurnView(await getTurnView({ query }, characterId));
  }
  return json({ reset: Object.keys(views).length, skipped, views });
};
