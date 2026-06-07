import { fail, redirect } from '@sveltejs/kit';
import { createCharacter, listCharacters } from '$lib/server/services/characters';

export async function load({ locals }) {
  return {
    characters: await listCharacters(locals.user!.id)
  };
}

export const actions = {
  create: async ({ request, locals }) => {
    const form = await request.formData();
    const name = String(form.get('name') || '').trim();
    if (!name) return fail(400, { error: 'Character name is required.' });

    const id = await createCharacter(locals.user!.id, name);
    throw redirect(303, `/characters/${id}`);
  }
};
