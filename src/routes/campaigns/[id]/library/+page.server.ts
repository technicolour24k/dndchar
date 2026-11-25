import { error, fail } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { getCampaignAccess } from '$lib/server/services/access';
import { loadCampaignLibraryPage, setCampaignLibrary } from '$lib/server/services/library';
import { CampaignError } from '$lib/server/campaignError';
import { attempt } from '$lib/server/campaignAction';
import { keepCampaignCopy } from '$lib/server/services/campaigns';
import { announceFork } from '$lib/server/libraryForkAnnounce';
import { describeFork } from '$lib/library/rules';

// Which members' homebrew libraries this campaign uses (homebrew library plan, unit D). A library is OFF until the
// DM or co-DM switches it on. Members can see the list; only canManage can change it, checked here and again in
// setCampaignLibrary. Switching off pulls nothing that is already in use (visibility gates new use only).
// "Keep a campaign copy" (unit G) is the freeze: it forks what the campaign uses of one member's library into campaign
// copies while that member stays. Same idempotent fork code as fork on leave.

export const load: PageServerLoad = async ({ params, locals }) => {
  // A stranger (or a bad id) gets 404, the same as the other campaign pages.
  const page = await loadCampaignLibraryPage({ query }, locals.user!.id, params.id);
  if (!page) throw error(404, 'Campaign not found.');
  return page;
};

export const actions: Actions = {
  setLibrary: async ({ request, params, locals }) => {
    const userId = locals.user!.id;
    const access = await getCampaignAccess({ query }, userId, params.id);
    if (!access?.canView) throw error(404, 'Campaign not found.');
    if (!access.canManage) throw error(403, 'Only the DM can change which libraries are used.');
    const form = await request.formData();
    try {
      await setCampaignLibrary(userId, params.id, String(form.get('ownerUserId') || ''), form.get('enabled') === '1');
      return { saved: true };
    } catch (err) {
      if (err instanceof CampaignError) return fail(400, { error: err.message });
      console.error('[campaign library] unexpected error', err);
      return fail(500, { error: 'Something went wrong, please try again.' });
    }
  },

  // DM / co-DM / admin only, checked here (403 for a player) and again inside keepCampaignCopy. The member must still be
  // in the campaign and the campaign live; the service re-checks both.
  keepCampaignCopy: async ({ request, params, locals }) => {
    const userId = locals.user!.id;
    const access = await getCampaignAccess({ query }, userId, params.id);
    if (!access?.canView) throw error(404, 'Campaign not found.');
    if (!access.canManage) throw error(403, 'Only the DM can keep campaign copies.');
    const form = await request.formData();
    const result = await attempt(() => keepCampaignCopy(userId, params.id, String(form.get('ownerUserId') || '')));
    if (!result.ok) return result.failure;
    announceFork(result.value.fork, result.value.roomCode);
    const fork = result.value.fork;
    return { forked: describeFork(fork.ownerName, fork.copies), reused: fork.reused, skipped: fork.skipped };
  }
};
