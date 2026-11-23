import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { getCampaignAccess } from '$lib/server/services/access';
import { getFindTableCampaignId, listEditableCampaigns, loadForageActor } from '$lib/server/services/forage';

// Find table authoring moved to /campaigns/[id]/forage (homebrew library plan, unit H). This old address stays so the
// nav link and old bookmarks still work:
//   ?table=<id>       -> that table's campaign page (the campaign page itself says 403/404 if you can't manage it)
//   bare, one campaign -> straight to that campaign's page
//   bare, several      -> a short list of the campaigns you manage (below)
export const load: PageServerLoad = async ({ url, locals }) => {
  const tableId = url.searchParams.get('table') || '';
  if (tableId) {
    const campaignId = await getFindTableCampaignId(tableId);
    // Only for someone who manages that campaign; anyone else falls through, same as an unknown id (no existence leak).
    if (campaignId && (await getCampaignAccess({ query }, locals.user!.id, campaignId))?.canManage) {
      throw redirect(302, `/campaigns/${campaignId}/forage?table=${tableId}`);
    }
  }
  const campaigns = await listEditableCampaigns(await loadForageActor(locals.user!));
  if (campaigns.length === 1) throw redirect(302, `/campaigns/${campaigns[0].id}/forage`);
  return { campaigns };
};
