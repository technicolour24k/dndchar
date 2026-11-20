import { redirect } from '@sveltejs/kit';
import { attempt } from '$lib/server/campaignAction';
import { findCampaignByInviteCode, joinCampaignByInviteCode } from '$lib/server/services/campaigns';
import { getCampaignAccess } from '$lib/server/services/access';
import { query } from '$lib/server/db';

// A GET never joins anyone (chat apps pre-fetch links), it only shows the confirm page. Logged-out
// visitors are bounced to /login?next=... by the hook and come back here afterwards.
export async function load({ params, locals }) {
  const campaign = await findCampaignByInviteCode(params.code);
  if (!campaign) return { code: params.code, campaign: null };
  // Already in: skip the confirm page.
  const access = await getCampaignAccess({ query }, locals.user!.id, campaign.id);
  if (access?.role) throw redirect(303, `/campaigns/${campaign.id}`);
  return { code: params.code, campaign };
}

export const actions = {
  join: async ({ params, locals }) => {
    const result = await attempt(() => joinCampaignByInviteCode(locals.user!.id, params.code));
    if (!result.ok) return result.failure;
    throw redirect(303, `/campaigns/${result.value}`);
  }
};
