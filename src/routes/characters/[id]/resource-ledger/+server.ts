import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';
import { getCharacterAccess } from '$lib/server/services/access';
import { listLedger } from '$lib/server/services/resource-pools';

// The newest 50 resource ledger rows for the Activity Log's "Resources" tab. Fetched only when that tab
// opens. Anyone who can view the sheet may read it (viewers included), same rule as the history route.
export const GET: RequestHandler = async ({ params, locals }) => {
  const access = await getCharacterAccess({ query }, locals.user!.id, params.id!);
  if (!access?.canView) throw error(404, 'Character not found.');
  return json({ rows: await listLedger(params.id!, 50) });
};
