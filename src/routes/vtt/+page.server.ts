import { parseListParams } from '$lib/campaigns/listParams';
import { listCampaigns } from '$lib/server/services/campaigns';

// The VTT lobby. hooks.server.ts already requires a logged-in user, so locals.user is guaranteed.
// It lists the campaigns the user really belongs to (membership only: a site admin who isn't a
// member gets no table ticket, so it would be a dead link) and links each to the static VTT client
// (a plain JS app under static/vtt-app) with the user's identity. The same ?q= / ?page= list
// parameters as /campaigns.
export async function load({ locals, url }) {
  const user = locals.user!;
  const params = parseListParams(url.searchParams, false);
  const list = await listCampaigns(user.id, { ...params, membersOnly: true });
  return { list, me: { id: user.id, name: user.displayName } };
}
