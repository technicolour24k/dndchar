import { error, fail, isRedirect, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { getCampaignAccess } from '$lib/server/services/access';
import { DEFAULT_FORAGE_CATEGORIES } from '$lib/rules/forage';
import {
  addFindTableEntry, createFindTable, getFindTableCampaignId, getFindTableEntries, listFindTables, loadForageActor,
  removeFindTableEntry, tablesForActor, toggleFindTableArchived, updateFindTable, updateFindTableEntries,
  type ForageActor
} from '$lib/server/services/forage';

// Find table authoring for ONE campaign (homebrew library plan, unit H; was /forage/tables). A campaign admin page like
// /campaigns/[id]/decks: canManage (DM / co-DM, plus the site-admin override) is checked here in load and in EVERY action
// (a player is 403, a stranger 404), and the service re-checks the table's campaign again on every write. Find tables
// belong to one campaign with no shared fallback. Finds review and undo stays on /admin/forage.

async function requireManager(userId: string, campaignId: string) {
  const access = await getCampaignAccess({ query }, userId, campaignId);
  if (!access?.canView) throw error(404, 'Campaign not found.');
  if (!access.canManage) throw error(403, "Only the DM can manage this campaign's find tables.");
  return access;
}

export const load: PageServerLoad = async ({ params, url, locals }) => {
  const access = await requireManager(locals.user!.id, params.id);
  const actor = await loadForageActor(locals.user!);
  // Only this campaign's tables. tablesForActor adds canEdit (true for a manager) and keeps the DM-side suggested check.
  const tables = tablesForActor(actor, await listFindTables(actor, params.id));
  const campaign = (await query<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [params.id])).rows[0];
  const requested = url.searchParams.get('table') || '';
  const selected = tables.find((table) => table.id === requested) ?? null;
  return {
    campaignId: params.id,
    campaignName: campaign?.name ?? '',
    archived: access.archived,
    tables,
    selected,
    entries: selected ? await getFindTableEntries(selected.id) : [],
    areaSuggestions: [...new Set(tables.map((table) => table.areaType))].sort(),
    categorySuggestions: [...new Set([...DEFAULT_FORAGE_CATEGORIES, ...tables.map((table) => table.category)])]
  };
};

type Run = (actor: ForageActor, form: FormData) => Promise<string>;

// Same try / redirect / fail shape as before. The campaign always comes from the URL: createTable's campaignId is
// overwritten, and any other action's table must belong to this campaign (a table id from another campaign is "not found").
function tableAction(run: Run, failure: string, isCreate = false) {
  return async ({ request, locals, params }: { request: Request; locals: App.Locals; params: { id: string } }) => {
    await requireManager(locals.user!.id, params.id);
    try {
      const form = await request.formData();
      if (isCreate) form.set('campaignId', params.id);
      else if ((await getFindTableCampaignId(String(form.get('tableId') || ''))) !== params.id) throw new Error('Find table not found.');
      const tableId = await run(await loadForageActor(locals.user!), form);
      throw redirect(303, `/campaigns/${params.id}/forage?table=${tableId}`);
    } catch (err) {
      if (isRedirect(err)) throw err;
      return fail(400, { error: err instanceof Error ? err.message : failure });
    }
  };
}

export const actions: Actions = {
  createTable: tableAction(createFindTable, 'Could not create the table.', true),
  updateTable: tableAction(updateFindTable, 'Could not save the table.'),
  archiveTable: tableAction(toggleFindTableArchived, 'Could not archive the table.'),
  addEntry: tableAction(addFindTableEntry, 'Could not add the item.'),
  saveEntries: tableAction(updateFindTableEntries, 'Could not save the entries.'),
  removeEntry: tableAction(removeFindTableEntry, 'Could not remove the item.')
};
