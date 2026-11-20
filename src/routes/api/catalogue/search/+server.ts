import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCatalogueIndex } from '$lib/server/services/catalogue';
import { searchCatalogue } from '$lib/catalogue/fuzzySearch';
import type { ContentType } from '$lib/types/content';

// db-traffic-reduction Phase 3: backs CatalogueSearch.svelte's debounced picker. Auth is the
// normal hooks.server.ts session gate (this path isn't public or bypassed there), so any request
// that gets this far already has locals.user set - no per-route check needed. Once the index is
// warm this makes zero DB queries: getCatalogueIndex() serves from the reference-data cache.
const pickerTypes = new Set<ContentType>(['spell', 'item', 'feat', 'class_feature']);

export const GET: RequestHandler = async ({ url }) => {
  const rawType = url.searchParams.get('type') || '';
  const type = pickerTypes.has(rawType as ContentType) ? (rawType as ContentType) : undefined;
  // Cap the query length defensively - a search box has no business sending more than this.
  const q = (url.searchParams.get('q') || '').slice(0, 60);

  const index = await getCatalogueIndex();
  const entries = searchCatalogue(index, q, { type, limit: 20 });

  return json({
    entries: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      spellLevel: entry.spellLevel,
      sourceKind: entry.sourceKind
    }))
  });
};
