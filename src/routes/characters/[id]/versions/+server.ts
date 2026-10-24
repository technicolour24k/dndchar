import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listVersions } from '$lib/server/services/characters';

// db-traffic-reduction Phase 4: Version History used to ship in every sheet load() just
// so the (rarely-opened) VersionList modal had its data ready instantly. It's now fetched
// only when the modal actually opens. listVersions() already does its own owner check
// (JOIN characters ON ... owner_user_id = $2), so there's nothing extra to check here -
// same as the load()-time call this replaces.
export const GET: RequestHandler = async ({ params, locals }) => {
  const versions = await listVersions(locals.user!.id, params.id!);
  return json({ versions });
};
