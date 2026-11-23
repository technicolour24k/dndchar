import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getCatalogueIndex } from '$lib/server/services/catalogue';
import { getCachedVisibleScope } from '$lib/server/services/library';
import { CampaignError } from '$lib/server/campaignError';
import { searchCatalogue } from '$lib/catalogue/fuzzySearch';
import { catalogueSourceLabel, isVisibleForNewUse } from '$lib/library/rules';
import type { ContentType } from '$lib/types/content';

// db-traffic-reduction Phase 3: backs CatalogueSearch.svelte's debounced picker. Auth is the
// normal hooks.server.ts session gate (this path isn't public or bypassed there), so any request
// that gets this far already has locals.user set. Once the index and the viewer's scope are warm this
// makes zero DB queries: both come from the reference-data cache.
//
// Homebrew library: results are limited to what the viewer may be OFFERED for new use. The scope is
// worked out from ?characterId= (that character's campaign) or ?campaignId=, or, with neither, the
// viewer's own library. Giving both is a 400; a character or campaign the viewer can't see is a 403.
const pickerTypes = new Set<ContentType>(['spell', 'item', 'feat', 'class_feature']);

export const GET: RequestHandler = async ({ url, locals }) => {
  const rawType = url.searchParams.get('type') || '';
  const type = pickerTypes.has(rawType as ContentType) ? (rawType as ContentType) : undefined;
  // Cap the query length defensively - a search box has no business sending more than this.
  const q = (url.searchParams.get('q') || '').slice(0, 60);
  const characterId = url.searchParams.get('characterId') || undefined;
  const campaignId = url.searchParams.get('campaignId') || undefined;
  if (characterId && campaignId) return json({ entries: [], error: 'Give a character or a campaign, not both.' }, { status: 400 });

  let scope;
  try {
    scope = await getCachedVisibleScope(locals.user!.id, { characterId, campaignId });
  } catch (error) {
    if (error instanceof CampaignError) return json({ entries: [], error: 'not_allowed' }, { status: 403 });
    throw error;
  }

  const index = await getCatalogueIndex();
  // The index holds live entries only, so isArchived is false here.
  const visible = (entry: (typeof index)[number]) => isVisibleForNewUse({
    scope: entry.scope, ownerUserId: entry.ownerUserId, campaignId: entry.campaignId,
    hiddenFromPlayers: entry.hiddenFromPlayers, isArchived: false, type: entry.type
  }, scope);
  const entries = searchCatalogue(index, q, { type, limit: 20, visible });

  return json({
    entries: entries.map((entry) => ({
      id: entry.id,
      type: entry.type,
      name: entry.name,
      spellLevel: entry.spellLevel,
      sourceKind: entry.sourceKind,
      sourceLabel: catalogueSourceLabel(entry)
    }))
  });
};
