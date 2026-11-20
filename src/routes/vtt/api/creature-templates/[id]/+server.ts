import { json } from '@sveltejs/kit';
import { deleteCreatureTemplate } from '$lib/server/services/creatureTemplates';

export async function DELETE({ params, locals }) {
  await deleteCreatureTemplate(locals.user!.id, params.id ?? '');
  return json({ ok: true });
}
