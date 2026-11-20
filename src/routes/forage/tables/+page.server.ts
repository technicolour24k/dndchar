import { fail, isRedirect, redirect } from '@sveltejs/kit';
import { DEFAULT_FORAGE_CATEGORIES } from '$lib/rules/forage';
import {
  addFindTableEntry, createFindTable, getFindTableEntries, listEditableCampaigns, listFindTables, loadForageActor,
  removeFindTableEntry, tablesForActor, toggleFindTableArchived, updateFindTable, updateFindTableEntries,
  type ForageActor
} from '$lib/server/services/forage';

// Find table authoring (campaign system Unit G). Deliberately NOT under /admin (that is admin-gated):
// the hooks already redirect anonymous users to /login. Find tables belong to a campaign, and the
// people who manage them are that campaign's primary DM and co-DM, plus site admins. This page
// lists only the tables the user can edit, so a player never sees a table name. The service
// enforces the same rule again on every write.

export async function load({ url, locals }: { url: URL; locals: App.Locals }) {
  const actor = await loadForageActor(locals.user!);
  // Adds canEdit (always true here, the list is already scoped) and the DM-side suggested check.
  const tables = tablesForActor(actor, await listFindTables(actor));
  const campaigns = await listEditableCampaigns(actor);
  const requested = url.searchParams.get('table') || '';
  const selected = tables.find((table) => table.id === requested) ?? null;
  return {
    tables,
    campaigns,
    // Anyone who can't manage any campaign gets an explanation instead of the editor.
    canManageAny: campaigns.length > 0 || tables.length > 0,
    selected,
    entries: selected ? await getFindTableEntries(selected.id) : [],
    areaSuggestions: [...new Set(tables.map((table) => table.areaType))].sort(),
    categorySuggestions: [...new Set([...DEFAULT_FORAGE_CATEGORIES, ...tables.map((table) => table.category)])]
  };
}

// Same try / redirect / fail shape as content-admin-page.ts.
function tableAction(run: (actor: ForageActor, form: FormData) => Promise<string>, failure: string) {
  return async ({ request, locals }: { request: Request; locals: App.Locals }) => {
    try {
      const tableId = await run(await loadForageActor(locals.user!), await request.formData());
      throw redirect(303, `?table=${tableId}`);
    } catch (error) {
      if (isRedirect(error)) throw error;
      return fail(400, { error: error instanceof Error ? error.message : failure });
    }
  };
}

export const actions = {
  createTable: tableAction(createFindTable, 'Could not create the table.'),
  updateTable: tableAction(updateFindTable, 'Could not save the table.'),
  archiveTable: tableAction(toggleFindTableArchived, 'Could not archive the table.'),
  addEntry: tableAction(addFindTableEntry, 'Could not add the item.'),
  saveEntries: tableAction(updateFindTableEntries, 'Could not save the entries.'),
  removeEntry: tableAction(removeFindTableEntry, 'Could not remove the item.')
};
