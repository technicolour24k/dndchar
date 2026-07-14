import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listCharacters } from '$lib/server/services/characters';

// Minimal shape for the VTT's "pick a character" combobox - id/name plus
// enough to disambiguate at a glance. No portrait field exists anywhere in
// this codebase yet, so there's nothing to include for one.
export const GET: RequestHandler = async ({ locals }) => {
  return json(await listCharacters(locals.user!.id));
};
