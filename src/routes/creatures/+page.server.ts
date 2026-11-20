import { fail } from '@sveltejs/kit';
import {
  deleteCreatureTemplate,
  listCreatureTemplates,
  sanitiseTemplatePatch,
  updateCreatureTemplate
} from '$lib/server/services/creatureTemplates';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Templates are per-user (the saving GM's own library), so there is no admin or campaign angle:
// everything here is scoped to the logged-in user's id in the service.
export async function load({ locals }) {
  return { templates: await listCreatureTemplates(locals.user!.id) };
}

export const actions = {
  // Rename and number edits in one form. Only whitelisted fields get through (see the service).
  save: async ({ request, locals }) => {
    const form = await request.formData();
    const id = String(form.get('id') || '');
    if (!UUID.test(id)) return fail(400, { error: 'Creature not found.', id });
    if (String(form.get('name') ?? '').trim() === '') return fail(400, { error: 'A creature needs a name.', id });

    const found = await updateCreatureTemplate(locals.user!.id, id, sanitiseTemplatePatch(form));
    if (!found) return fail(404, { error: 'Creature not found.', id });
    return { saved: id };
  },

  delete: async ({ request, locals }) => {
    const form = await request.formData();
    const id = String(form.get('id') || '');
    if (!UUID.test(id)) return fail(400, { error: 'Creature not found.', id });
    await deleteCreatureTemplate(locals.user!.id, id);
    return { deleted: id };
  }
};
