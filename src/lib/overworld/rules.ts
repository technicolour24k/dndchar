// Pure access rules for overworld maps, pins and routes. No I/O, so the server services, the page
// loaders and the tests all share one definition. Importable from client code: it only pulls in types
// (and copies the two-line isDmRole rather than importing access.ts, which drags in server code).
//
// Only the campaign role matters (Rev 2: least privilege). 'dm' (primary) and 'co_dm' are both DMs.
// The site admin flag plays no part at all: an admin who is a player has player rights, an admin who
// is a DM has DM rights, and an admin who is not a member has no overworld access.
import type { CampaignRole } from '$lib/types/campaign';
import type { ItemFacts, MapFacts, OverworldViewer, PinKind } from '$lib/types/overworld';

export type { ItemFacts, MapFacts, OverworldViewer, PinKind };

// Copy of access.ts isDmRole (see the note above).
function isDmRole(role: CampaignRole | null | undefined): boolean {
  return role === 'dm' || role === 'co_dm';
}

// A campaign DM (primary or co-DM), by real role only.
export function isOverworldDm(v: OverworldViewer): boolean {
  return isDmRole(v.role);
}

// Members only, and only while the campaign is live: an archived campaign is closed to everyone.
export function canOpenOverworld(v: OverworldViewer): boolean {
  return !v.campaignArchived && v.role !== null;
}

// Same as opening: nobody writes in an archived campaign.
export function canWrite(v: OverworldViewer): boolean {
  return canOpenOverworld(v);
}

// Create / upload, rename, replace image, scale, grant, ungrant, archive: DMs only.
export function canManageMaps(v: OverworldViewer): boolean {
  return canWrite(v) && isOverworldDm(v);
}

// Archived maps are gone for everyone; ungranted maps are for DMs only.
export function canSeeMap(v: OverworldViewer, map: MapFacts): boolean {
  return canOpenOverworld(v) && map.archivedAt === null && (map.grantedAt !== null || isOverworldDm(v));
}

// Callers must gate by canSeeMap / canOpenOverworld first, and load campaignArchived fresh inside the write transaction.
// Private items: the creator and both DMs. Also used by the live route preview filter.
export function canSeeItem(v: OverworldViewer, item: ItemFacts): boolean {
  return item.visibility === 'everyone' || item.createdByUserId === v.userId || isOverworldDm(v);
}

// Anyone writing may add a pin or a route (routes count as 'pin' level); party pins are DM only.
export function canCreate(v: OverworldViewer, kind: PinKind): boolean {
  return canWrite(v) && (kind === 'pin' || isOverworldDm(v));
}

// "Added by a DM" is frozen at creation: party pins and anything a DM creates.
export function dmLockedOnCreate(v: OverworldViewer, kind: PinKind): boolean {
  return kind === 'party' || isOverworldDm(v);
}

// DM-added items are editable by DMs only; anything else by anyone who can see it.
export function canEditItem(v: OverworldViewer, item: ItemFacts): boolean {
  return canWrite(v) && canSeeItem(v, item) && (!item.dmLocked || isOverworldDm(v));
}

// Visibility can only be changed by the creator or a DM (as well as passing the edit rule).
export function canChangeVisibility(v: OverworldViewer, item: ItemFacts): boolean {
  return canEditItem(v, item) && (item.createdByUserId === v.userId || isOverworldDm(v));
}
