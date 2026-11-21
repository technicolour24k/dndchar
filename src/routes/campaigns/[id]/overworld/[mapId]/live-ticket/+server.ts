import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getLivePreviewAccess } from '$lib/server/services/overworld';
import { issueOverworldLiveTicket } from '$vtt/store.js';

// POST /campaigns/<id>/overworld/<mapId>/live-ticket
//
// One-use ticket (60 s) for the map's live route-preview channel on the VTT socket server (see
// vtt/server/store.js, "Overworld live route preview"). Issued only to someone who may see the map
// (campaign role only, the site admin plays no part). Anything else is a plain 404, like the image route.
export const POST: RequestHandler = async ({ params, locals }) => {
  const user = locals.user;
  if (!user) return json({ error: 'not_found' }, { status: 404 });
  const access = await getLivePreviewAccess(user.id, params.id, params.mapId);
  if (!access) return json({ error: 'not_found' }, { status: 404 });
  const ticket = issueOverworldLiveTicket({
    campaignId: params.id,
    mapId: params.mapId,
    userId: user.id,
    displayName: user.displayName,
    isDm: access.isDm
  });
  return json({ ticket });
};
