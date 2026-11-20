import { listCharacters } from '$lib/server/services/characters';

export async function load({ locals }) {
  return {
    characters: await listCharacters(locals.user!.id)
  };
}
