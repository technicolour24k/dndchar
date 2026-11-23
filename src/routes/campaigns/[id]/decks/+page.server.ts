import { error, fail, redirect, type ActionFailure } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { getCampaignAccess } from '$lib/server/services/access';
import {
  copyDeckToCampaign, createDeck, DeckError, dryRunDraw, getOwnDeck, listDecksForManagement, toggleDeckArchived, updateDeck
} from '$lib/server/services/decks';

// The campaign's deck management page (decks plan, unit 9b): the first "campaign admin" page. Admin pages are for
// globals; this one controls what is specific to ONE campaign. A deck a DM creates is owned by the campaign.
// Global decks are read-only here and can be copied into the campaign. Access is canManage (DM / co-DM, plus the
// site-admin override), checked here and again in every service call. Writes on an archived campaign are refused.

export const load: PageServerLoad = async ({ params, locals, url }) => {
  const userId = locals.user!.id;
  const access = await getCampaignAccess({ query }, userId, params.id);
  if (!access) throw error(404, 'Campaign not found.');
  if (!access.canManage) throw error(403, 'Only the DM can manage this campaign\'s decks.');
  const campaign = (await query<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [params.id])).rows[0];
  const wanted = url.searchParams.get('deck');
  const [decks, selected] = await Promise.all([
    listDecksForManagement(userId, params.id),
    wanted ? getOwnDeck(userId, params.id, wanted) : Promise.resolve(null)
  ]);
  return { campaignId: params.id, campaignName: campaign?.name ?? '', archived: access.archived, decks, selected, requested: wanted };
};

type Failure = ActionFailure<{ error: string }>;

// Deck errors carry player-facing messages; anything else is logged and shown generically.
async function attemptDeck<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: Failure }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof DeckError) return { ok: false, failure: fail(err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400, { error: err.message }) };
    console.error('[campaign decks] unexpected error', err);
    return { ok: false, failure: fail(500, { error: 'Something went wrong, please try again.' }) };
  }
}

export const actions: Actions = {
  create: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attemptDeck(() => createDeck({
      userId: locals.user!.id, campaignId: params.id, name: String(form.get('name') ?? ''), description: String(form.get('description') ?? '')
    }));
    if (!result.ok) return result.failure;
    throw redirect(303, `/campaigns/${params.id}/decks?deck=${result.value}`);
  },

  // Copies a global deck into this campaign and opens the copy.
  copy: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attemptDeck(() => copyDeckToCampaign({ userId: locals.user!.id, campaignId: params.id, sourceId: String(form.get('sourceId') ?? '') }));
    if (!result.ok) return result.failure;
    throw redirect(303, `/campaigns/${params.id}/decks?deck=${result.value}`);
  },

  // Nothing is saved when there is any error; the typed text comes back so no work is lost.
  save: async ({ request, params, locals }) => {
    const form = await request.formData();
    const input = {
      id: String(form.get('id') ?? ''), name: String(form.get('name') ?? ''),
      description: String(form.get('description') ?? ''), rulesText: String(form.get('rulesText') ?? '')
    };
    const result = await attemptDeck(() => updateDeck({ userId: locals.user!.id, campaignId: params.id, ...input }));
    if (!result.ok) return result.failure;
    if (!result.value.ok) return fail(400, { saveErrors: result.value.errors, draft: input });
    return { saved: input.id, warnings: result.value.warnings };
  },

  archive: async ({ request, params, locals }) => {
    const form = await request.formData();
    const result = await attemptDeck(() => toggleDeckArchived({
      userId: locals.user!.id, campaignId: params.id, id: String(form.get('id') ?? ''), archived: form.get('archived') === '1'
    }));
    if (!result.ok) return result.failure;
    return result.value ? { archivedChanged: true } : fail(404, { error: 'Deck not found.' });
  },

  // Plans one card against a fake party using the SAVED rules. Writes nothing.
  testDraw: async ({ request, params, locals }) => {
    const form = await request.formData();
    const success = String(form.get('success') ?? 'auto');
    const result = await attemptDeck(() => dryRunDraw({
      userId: locals.user!.id, campaignId: params.id, id: String(form.get('id') ?? ''), cardId: String(form.get('cardId') ?? ''),
      success: success === 'success' || success === 'failure' ? success : 'auto',
      value: form.get('value') ? Number(form.get('value')) : null
    }));
    if (!result.ok) return result.failure;
    if (result.value.error) return fail(400, { testError: result.value.error });
    return { testLines: result.value.lines };
  }
};
