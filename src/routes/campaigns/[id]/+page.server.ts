import { error, fail, redirect } from '@sveltejs/kit';
import { attempt } from '$lib/server/campaignAction';
import { leaveState, memberControls } from '$lib/server/campaignControls';
import {
  addCharacterToCampaign,
  archiveCampaign,
  getCampaignPage,
  leaveCampaign,
  regenerateInviteCode,
  removeCharacterFromCampaign,
  removeMember,
  setCharacterPartyActive,
  setMemberRole,
  updateCampaignDetails
} from '$lib/server/services/campaigns';
import type { CampaignRole } from '$lib/types/campaign';

// Every action below only forwards to the campaign service, which does the real permission check
// (access.ts). The controls computed in load are just what to show.
export async function load({ params, locals }) {
  const user = locals.user!;
  const page = await getCampaignPage(user.id, params.id);
  if (!page) throw error(404, 'Campaign not found.');

  const viewer = { userId: user.id, role: page.access.role, isAdmin: page.access.isAdmin };
  const archived = page.campaign.isArchived;
  return {
    ...page,
    viewerId: user.id,
    controls: memberControls(viewer, page.members, archived),
    leave: leaveState(viewer, page.members, archived),
    hasNoDm: !page.members.some((m) => m.role === 'dm'),
    // The admin banner is for people who only have access through the override.
    viaAdmin: page.access.isAdmin && !page.access.isDm
  };
}

const ROLES: CampaignRole[] = ['dm', 'co_dm', 'player'];

export const actions = {
  update: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() =>
      updateCampaignDetails(locals.user!.id, params.id, String(form.get('name') || ''), String(form.get('description') || ''))
    );
    return result.ok ? { saved: 'details' } : result.failure;
  },

  regenerate: async ({ params, locals }) => {
    const result = await attempt(() => regenerateInviteCode(locals.user!.id, params.id));
    return result.ok ? { saved: 'invite' } : result.failure;
  },

  setRole: async ({ request, params, locals }) => {
    const form = await request.formData();
    const role = String(form.get('role') || '') as CampaignRole;
    if (!ROLES.includes(role)) return fail(400, { error: 'Unknown role.' });
    const result = await attempt(() => setMemberRole(locals.user!.id, params.id, String(form.get('userId') || ''), role));
    return result.ok ? { saved: 'role' } : result.failure;
  },

  removeMember: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => removeMember(locals.user!.id, params.id, String(form.get('userId') || '')));
    return result.ok ? { saved: 'removed' } : result.failure;
  },

  leave: async ({ params, locals }) => {
    const result = await attempt(() => leaveCampaign(locals.user!.id, params.id));
    if (!result.ok) return result.failure;
    throw redirect(303, '/campaigns');
  },

  archive: async ({ params, locals }) => {
    const result = await attempt(() => archiveCampaign(locals.user!.id, params.id));
    if (!result.ok) return result.failure;
    throw redirect(303, '/campaigns');
  },

  addCharacter: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => addCharacterToCampaign(locals.user!.id, String(form.get('characterId') || ''), params.id));
    return result.ok ? { saved: 'character' } : result.failure;
  },

  removeCharacter: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attempt(() => removeCharacterFromCampaign(locals.user!.id, String(form.get('characterId') || ''), params.id));
    return result.ok ? { saved: 'character' } : result.failure;
  },

  setActive: async ({ request, params, locals }) => {
    const form = await request.formData();
    const active = form.get('active') === '1';
    const result = await attempt(() => setCharacterPartyActive(locals.user!.id, String(form.get('characterId') || ''), active, params.id));
    return result.ok ? { saved: 'character' } : result.failure;
  }
};
