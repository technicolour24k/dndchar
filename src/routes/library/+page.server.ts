import { fail, isRedirect, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  libraryAddAction, libraryAddResource, libraryAddSpellAccess, libraryAttachAction, libraryAttachEffect, libraryAttachModifier,
  libraryDetachAction, libraryDetachEffect, libraryDetachModifier, libraryGrantContent, libraryRemoveActionStep,
  libraryRemoveSpellAccess, createLibraryEntry, loadLibraryPage, parseLibraryTab, tabForType, toggleLibraryArchive,
  updateLibraryEntry
} from '$lib/server/services/library-authoring';
import { query } from '$lib/server/db';
import { isUuid } from '$lib/server/services/access';
import type { ContentType } from '$lib/types/content';

// The personal homebrew library (plans/dndchar/homebrew-library, unit C). Everyone has one. Anyone can write
// descriptive items, spells, feats and features; adding rules (modifiers, costs, charges, actions) is DM/admin only,
// checked in every action in library-authoring.ts. Each action only ever touches the signed-in user's own entries.
// The action names mirror createContentAdminPage so the shared editor component works unchanged.

export const load: PageServerLoad = async ({ locals, url }) => {
  // Decks have their own page (unit E): their editor is the rules JSON one, not the item/spell/feat editor.
  if (url.searchParams.get('type') === 'deck') throw redirect(303, '/library/decks');
  const tab = parseLibraryTab(url.searchParams.get('type'));
  return loadLibraryPage(locals.user!.id, tab, url.searchParams.get('content') || '', url.searchParams.get('from') || '');
};

// Where to land after a write: the same tab with the entry selected, and the "from" character kept.
async function backTo(id: string, from: string): Promise<string> {
  const row = (await query<{ content_type: ContentType }>('SELECT content_type FROM content_definitions WHERE id = $1', [id])).rows[0];
  const params = new URLSearchParams({ type: row ? tabForType(row.content_type) : 'item', content: id });
  if (isUuid(from)) params.set('from', from);
  return `/library?${params}`;
}

type Writer = (userId: string, form: FormData) => Promise<string | void>;

// One shape for every write: run it, redirect back to the entry, or return the message. Errors from the
// services (ownership, tier, references) carry player-facing text.
function writer(run: Writer, fallback: string, idField = 'contentId') {
  return async ({ request, locals, url }: { request: Request; locals: App.Locals; url: URL }) => {
    const form = await request.formData();
    try {
      const id = (await run(locals.user!.id, form)) || String(form.get(idField) || '');
      throw redirect(303, await backTo(id, url.searchParams.get('from') || ''));
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { error: error instanceof Error ? error.message : fallback });
    }
  };
}

export const actions: Actions = {
  create: writer(createLibraryEntry, 'Could not create entry.'),
  update: writer(updateLibraryEntry, 'Could not update entry.'),
  archive: writer(async (userId, form) => toggleLibraryArchive(userId, form), 'Could not archive entry.'),
  attachModifier: writer(libraryAttachModifier, 'Could not attach modifier.'),
  detachModifier: writer(libraryDetachModifier, 'Could not remove modifier.'),
  attachEffect: writer(libraryAttachEffect, 'Could not attach effect.'),
  detachEffect: writer(libraryDetachEffect, 'Could not remove effect.'),
  addResource: writer(async (userId, form) => { await libraryAddResource(userId, form); }, 'Could not add counter.'),
  grantContent: writer(async (userId, form) => { await libraryGrantContent(userId, form); }, 'Could not attach granted content.', 'sourceContentId'),
  addResourceAction: writer(libraryAddAction, 'Could not add action.'),
  removeResourceAction: writer(libraryRemoveActionStep, 'Could not remove action.'),
  attachAction: writer(libraryAttachAction, 'Could not attach action.'),
  detachAction: writer(libraryDetachAction, 'Could not remove action.'),
  addSpellAccess: writer(libraryAddSpellAccess, 'Could not grant spell.'),
  removeSpellAccess: writer(libraryRemoveSpellAccess, 'Could not remove spell access.')
};
