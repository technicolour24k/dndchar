import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { isUuid } from '$lib/server/services/access';
import { setDrawTaskDone } from '$lib/server/services/decks';
import { announceDmTasks } from '$lib/server/vttDeckAnnounce';
import { badInput, deckErrorResponse } from '$lib/server/vttDeckApi';
import { query } from '$lib/server/db';

// POST { taskId, done }: the DM ticks a "waiting on the DM" task off (or back on). DM only (the service checks).
export const POST: RequestHandler = async ({ locals, params, request }) => {
  const body = await request.json().catch(() => ({}));
  if (!isUuid(body?.taskId) || typeof body?.done !== 'boolean') return badInput('taskId and done are required.');
  try {
    const draw = await setDrawTaskDone({ userId: locals.user!.id, drawId: params.id, taskId: body.taskId, done: body.done });
    const room = await query<{ room_code: string | null }>('SELECT room_code FROM campaigns WHERE id = $1', [draw.campaignId]);
    const roomCode = room.rows[0]?.room_code;
    if (roomCode) await announceDmTasks(roomCode, draw.campaignId);
    return json({ draw });
  } catch (error) {
    return deckErrorResponse(error);
  }
};
