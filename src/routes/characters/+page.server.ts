import { fail, redirect } from '@sveltejs/kit';
import { createCharacter, listCharacters } from '$lib/server/services/characters';
import { listCampaignCharactersForUser } from '$lib/server/services/campaigns';

export async function load({ locals }) {
  const [characters, campaignCharacters] = await Promise.all([
    listCharacters(locals.user!.id),
    // Other people's characters in the user's campaigns (read-only for plain members).
    listCampaignCharactersForUser(locals.user!.id)
  ]);
  return { characters, campaignCharacters };
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
