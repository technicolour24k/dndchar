import { fail, isRedirect, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
  archiveLibraryCondition, attachLibraryConditionModifier, createLibraryCondition, detachLibraryConditionModifier,
  loadLibraryConditions, saveLibraryCondition
} from '$lib/server/services/library-conditions';

// Personal conditions in the homebrew library (plans/dndchar/homebrew-library, unit F). DM-tier: a condition carries
// modifiers, so the services check mechanics rights on every write that adds rules, and ownership on every write.
// Each action only ever touches the signed-in user's own conditions. A condition is referenced, not copied: where a
// DM switches this library on, decks and sheets in that campaign use it by reference.

export const load: PageServerLoad = async ({ locals, url }) => loadLibraryConditions(locals.user!.id, url.searchParams.get('condition') || '');

// One shape for every write: run it, then redirect back to the condition, or return the message.
function writer(run: (userId: string, form: FormData) => Promise<string>, fallback: string) {
  return async ({ request, locals }: { request: Request; locals: App.Locals }) => {
    const form = await request.formData();
    try {
      const id = await run(locals.user!.id, form);
      throw redirect(303, `/library/conditions?condition=${id}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { error: error instanceof Error ? error.message : fallback });
    }
  };
}

export const actions: Actions = {
  create: writer(createLibraryCondition, 'Could not create condition.'),
  save: writer(saveLibraryCondition, 'Could not save condition.'),
  archive: writer((userId, form) => archiveLibraryCondition(userId, String(form.get('effectId') || '')), 'Could not archive condition.'),
  attach: writer(attachLibraryConditionModifier, 'Could not attach modifier.'),
  detach: writer(detachLibraryConditionModifier, 'Could not remove modifier.')
};
