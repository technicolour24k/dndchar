import { error, fail, isRedirect, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { getCampaignAccess } from '$lib/server/services/access';
import {
  attachCampaignConditionModifier, campaignAddAction, campaignAddResource, campaignAddSpellAccess, campaignAttachAction,
  campaignAttachEffect, campaignAttachModifier, campaignDetachAction, campaignDetachEffect, campaignDetachModifier,
  campaignGrantContent, campaignRemoveActionStep, campaignRemoveSpellAccess, detachCampaignConditionModifier, homebrewTabForType,
  loadCampaignHomebrew, parseHomebrewTab, saveCampaignCondition, toggleCampaignEntryArchive, updateCampaignEntry
} from '$lib/server/services/library-campaign';
import type { ContentType } from '$lib/types/content';

// The campaign's copies of former (or still present) members' homebrew (homebrew library plan, unit G). Copies are made
// by a fork, never from scratch, so there is no `create` action here at all (a forged one finds no action and fails).
// DM / co-DM / admin only: canManage is checked in load and again in EVERY action (a player is 403, a stranger 404),
// then each service re-checks that the entry is a copy of THIS campaign.

export const load: PageServerLoad = async ({ params, locals, url }) => {
  const tab = parseHomebrewTab(url.searchParams.get('type'));
  const result = await loadCampaignHomebrew(locals.user!.id, params.id, tab, url.searchParams.get('content') || '');
  if (result.status === 'missing') throw error(404, 'Campaign not found.');
  if (result.status === 'forbidden') throw error(403, "Only the DM can edit this campaign's copies.");
  return result.data;
};

async function requireManager(userId: string, campaignId: string) {
  const access = await getCampaignAccess({ query }, userId, campaignId);
  if (!access?.canView) throw error(404, 'Campaign not found.');
  if (!access.canManage) throw error(403, "Only the DM can edit this campaign's copies.");
}

// Where to land after a write: the same tab with the entry selected.
async function backTo(campaignId: string, id: string): Promise<string> {
  const row = (await query<{ content_type: ContentType }>('SELECT content_type FROM content_definitions WHERE id = $1', [id])).rows[0];
  const params = new URLSearchParams({ type: row ? homebrewTabForType(row.content_type) : 'item', content: id });
  return `/campaigns/${campaignId}/homebrew?${params}`;
}

type Writer = (userId: string, campaignId: string, form: FormData) => Promise<string | void>;

// One shape for every write: check the manager, run it, redirect back to the entry or return the message.
function writer(run: Writer, fallback: string, idField = 'contentId') {
  return async ({ request, locals, params }: { request: Request; locals: App.Locals; params: { id: string } }) => {
    await requireManager(locals.user!.id, params.id);
    const form = await request.formData();
    try {
      const id = (await run(locals.user!.id, params.id, form)) || String(form.get(idField) || '');
      throw redirect(303, await backTo(params.id, id));
    } catch (err) {
      if (isRedirect(err)) throw err;
      return fail(400, { error: err instanceof Error ? err.message : fallback });
    }
  };
}

export const actions: Actions = {
  update: writer(updateCampaignEntry, 'Could not update entry.'),
  archive: writer(toggleCampaignEntryArchive, 'Could not archive entry.'),
  attachModifier: writer(campaignAttachModifier, 'Could not attach modifier.'),
  detachModifier: writer(campaignDetachModifier, 'Could not remove modifier.'),
  attachEffect: writer(campaignAttachEffect, 'Could not attach effect.'),
  detachEffect: writer(campaignDetachEffect, 'Could not remove effect.'),
  addResource: writer(async (u, c, f) => { await campaignAddResource(u, c, f); }, 'Could not add counter.'),
  grantContent: writer(async (u, c, f) => { await campaignGrantContent(u, c, f); }, 'Could not attach granted content.', 'sourceContentId'),
  addResourceAction: writer(campaignAddAction, 'Could not add action.'),
  removeResourceAction: writer(campaignRemoveActionStep, 'Could not remove action.'),
  attachAction: writer(campaignAttachAction, 'Could not attach action.'),
  detachAction: writer(campaignDetachAction, 'Could not remove action.'),
  addSpellAccess: writer(campaignAddSpellAccess, 'Could not grant spell.'),
  removeSpellAccess: writer(campaignRemoveSpellAccess, 'Could not remove spell access.'),
  // The condition editor's actions (same names as /library/conditions).
  save: writer(saveCampaignCondition, 'Could not save condition.', 'effectId'),
  attach: writer(attachCampaignConditionModifier, 'Could not attach modifier.', 'effectId'),
  detach: writer(detachCampaignConditionModifier, 'Could not remove modifier.', 'effectId')
};
