import { fail, isRedirect, redirect } from '@sveltejs/kit';
import { DEFAULT_FORAGE_CATEGORIES } from '$lib/rules/forage';
import {
  addFindTableEntry, createFindTable, getFindTableEntries, listFindTables,
  removeFindTableEntry, tablesForActor, toggleFindTableArchived, updateFindTable, updateFindTableEntries,
  type ForageActor
} from '$lib/server/services/forage';

// Find table authoring. Deliberately NOT under /admin (that is admin-gated): any logged-in user may
// author tables (the hooks already redirect anonymous users to /login), and editing is owner-or-admin,
// enforced again in the service. Tables get campaign scoping once campaigns land.

function actorFor(locals: App.Locals): ForageActor {
  return { id: locals.user!.id, role: locals.user!.role };
}

export async function load({ url, locals }: { url: URL; locals: App.Locals }) {
  const actor = actorFor(locals);
  // Adds canEdit and hides the suggested check from non-owners (Q9).
  const tables = tablesForActor(actor, await listFindTables());
  const requested = url.searchParams.get('table') || '';
  const selected = tables.find((table) => table.id === requested) ?? null;
  return {
    tables,
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
      const tableId = await run(actorFor(locals), await request.formData());
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
