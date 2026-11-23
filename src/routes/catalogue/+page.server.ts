import { error } from '@sveltejs/kit';
import { query } from '$lib/server/db';
import { getCampaignAccess, isUuid } from '$lib/server/services/access';
import { listCatalogue } from '$lib/server/services/catalogue';
import { loadCampaignLibraries, resolveVisibleScope } from '$lib/server/services/library';
import type { VisibleScope } from '$lib/library/rules';
import type { ContentType } from '$lib/types/content';

// Read-only browse (homebrew library plan, unit D2). Authoring lives on /library (your own homebrew), /admin (global
// content) and the campaign pages, never here.
//   /catalogue                      global plus your own library
//   /catalogue?campaign=<id>        what that campaign may be offered: global, its enabled libraries, its own copies
//   /catalogue?campaign=<id>&owner=<userId>   one member's library (members: when it is on; DMs can also preview it off)
const BROWSE_TYPES: ContentType[] = ['item', 'spell', 'feat', 'class_feature'];

export async function load({ locals, url }) {
  const userId = locals.user!.id;
  const rawType = url.searchParams.get('type') || '';
  const type = BROWSE_TYPES.includes(rawType as ContentType) ? rawType as ContentType : undefined;
  const search = url.searchParams.get('search') || '';
  const campaignId = url.searchParams.get('campaign') || '';
  const ownerId = url.searchParams.get('owner') || '';

  let scope: VisibleScope | undefined; // undefined = the viewer's own pages
  let campaign: { id: string; name: string } | null = null;
  let owner: { id: string; name: string; enabled: boolean } | null = null;
  if (campaignId) {
    // An unknown, unviewable or malformed campaign is a 404 (same as every campaign page).
    const access = isUuid(campaignId) ? await getCampaignAccess({ query }, userId, campaignId) : null;
    if (!access?.canView) throw error(404, 'Campaign not found.');
    const name = (await query<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [campaignId])).rows[0]?.name;
    if (name === undefined) throw error(404, 'Campaign not found.');
    campaign = { id: campaignId, name };
    scope = await resolveVisibleScope({ query }, userId, { campaignId });
    if (ownerId) {
      // Only a current member's library can be browsed this way.
      const libraries = await loadCampaignLibraries({ query }, campaignId);
      if (!isUuid(ownerId) || !libraries.memberIds.includes(ownerId)) throw error(404, 'Library not found.');
      const enabled = libraries.enabledOwnerIds.includes(ownerId);
      // Off: only a manager may peek (to decide whether to switch it on). Players get nothing.
      if (!enabled && !access.canManage) throw error(404, 'Library not found.');
      const display = (await query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [ownerId])).rows[0]?.display_name ?? 'Someone';
      owner = { id: ownerId, name: display, enabled };
      scope = { campaignId: null, ownerIds: [ownerId], hiddenOkOwnerIds: access.canManage || ownerId === userId ? [ownerId] : [], hiddenOkCampaign: false };
    }
  }

  // The owner filter runs in SQL so the list's row cap can never cut off the member's entries.
  const rows = await listCatalogue(userId, type, search, scope, owner?.id);
  // The "All" list would also include conditions and actions; this page only browses the four player-facing types.
  const content = rows.filter((entry) => BROWSE_TYPES.includes(entry.type));
  return { content, type: rawType, campaign, owner, search };
}
