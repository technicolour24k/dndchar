import { fail, redirect } from '@sveltejs/kit';
import { parseListParams } from '$lib/campaigns/listParams';
import { attempt } from '$lib/server/campaignAction';
import { createCampaign, joinCampaignByInviteCode, listCampaigns } from '$lib/server/services/campaigns';

// The list is a plain GET (?q=&page=&archived=) so searches are linkable and work without JS.
export async function load({ locals, url }) {
  const user = locals.user!;
  const isAdmin = user.role === 'admin';
  const params = parseListParams(url.searchParams, isAdmin);
  const list = await listCampaigns(user.id, params);
  return { list, isAdmin };
}

export const actions = {
  create: async ({ request, locals }) => {
    const form = await request.formData();
    const name = String(form.get('name') || '');
    const description = String(form.get('description') || '');
    const result = await attempt(() => createCampaign(locals.user!.id, name, description));
    if (!result.ok) return fail(400, { error: result.failure.data.error, createName: name, createDescription: description });
    throw redirect(303, `/campaigns/${result.value}`);
  },

  join: async ({ request, locals }) => {
    const form = await request.formData();
    const code = String(form.get('code') || '');
    const result = await attempt(() => joinCampaignByInviteCode(locals.user!.id, code));
    if (!result.ok) return fail(400, { error: result.failure.data.error, joinCode: code });
    throw redirect(303, `/campaigns/${result.value}`);
  }
};
