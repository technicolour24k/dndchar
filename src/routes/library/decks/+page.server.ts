import { fail, redirect, type ActionFailure } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { countHolders, loadLibraryActor } from '$lib/server/services/library';
import {
  createPersonalDeck, DeckError, dryRunPersonalDraw, getPersonalDeck, listPersonalDecks, togglePersonalDeckArchived, updatePersonalDeck
} from '$lib/server/services/decks';

// Personal decks in the homebrew library (plans/dndchar/homebrew-library, unit E). Decks are DM-tier: their rules count
// as mechanics, so create and save need mechanics rights (checked in the service on every write). Everything here only
// ever touches the signed-in user's own decks. A deck is referenced, not copied, where a DM enables it, so a save
// reaches every campaign using it; the "Used in K campaigns" note says so.

export const load: PageServerLoad = async ({ locals, url }) => {
  const userId = locals.user!.id;
  const wanted = url.searchParams.get('deck');
  const [actor, decks, selected] = await Promise.all([
    loadLibraryActor({ query }, userId),
    listPersonalDecks(userId),
    wanted ? getPersonalDeck(userId, wanted) : Promise.resolve(null)
  ]);
  const holders = selected ? await countHolders({ query }, selected.id) : null;
  return { decks, selected, requested: wanted, canAuthorMechanics: actor.canAuthorMechanics, campaigns: holders?.campaigns ?? 0 };
};

type Failure = ActionFailure<{ error: string }>;

// Deck errors carry player-facing messages; anything else is logged and shown generically.
async function attemptDeck<T>(fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; failure: Failure }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    if (err instanceof DeckError) return { ok: false, failure: fail(err.code === 'forbidden' ? 403 : err.code === 'not_found' ? 404 : 400, { error: err.message }) };
    console.error('[library decks] unexpected error', err);
    return { ok: false, failure: fail(500, { error: 'Something went wrong, please try again.' }) };
  }
}

export const actions: Actions = {
  create: async ({ request, locals }) => {
    const form = await request.formData();
    const result = await attemptDeck(() => createPersonalDeck({
      userId: locals.user!.id, name: String(form.get('name') ?? ''), description: String(form.get('description') ?? '')
    }));
    if (!result.ok) return result.failure;
    throw redirect(303, `/library/decks?deck=${result.value}`);
  },

  // Nothing is saved when there is any error; the typed text comes back so no work is lost.
  save: async ({ request, locals }) => {
    const form = await request.formData();
    const input = {
      id: String(form.get('id') ?? ''), name: String(form.get('name') ?? ''),
      description: String(form.get('description') ?? ''), rulesText: String(form.get('rulesText') ?? '')
    };
    const result = await attemptDeck(() => updatePersonalDeck({ userId: locals.user!.id, ...input }));
    if (!result.ok) return result.failure;
    if (!result.value.ok) return fail(400, { saveErrors: result.value.errors, draft: input });
    return { saved: input.id, warnings: result.value.warnings };
  },

  archive: async ({ request, locals }) => {
    const form = await request.formData();
    const result = await attemptDeck(() => togglePersonalDeckArchived({
      userId: locals.user!.id, id: String(form.get('id') ?? ''), archived: form.get('archived') === '1'
    }));
    if (!result.ok) return result.failure;
    return result.value ? { archivedChanged: true } : fail(404, { error: 'Deck not found.' });
  },

  // Plans one card against a fake party using the SAVED rules. Writes nothing.
  testDraw: async ({ request, locals }) => {
    const form = await request.formData();
    const success = String(form.get('success') ?? 'auto');
    const result = await attemptDeck(() => dryRunPersonalDraw({
      userId: locals.user!.id, id: String(form.get('id') ?? ''), cardId: String(form.get('cardId') ?? ''),
      success: success === 'success' || success === 'failure' ? success : 'auto',
      value: form.get('value') ? Number(form.get('value')) : null
    }));
    if (!result.ok) return result.failure;
    if (result.value.error) return fail(400, { testError: result.value.error });
    return { testLines: result.value.lines };
  }
};
