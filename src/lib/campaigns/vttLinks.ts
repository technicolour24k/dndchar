// Links into the VTT, shared by the /vtt lobby and the campaign page's "Open table" buttons.
// (static/vtt-app/shared/campaignJoin.js has a browser copy of tableHref; a test keeps them equal.)

import type { CampaignRole } from '$lib/types/campaign';

/** A campaign table link: opens the static VTT client in campaign mode, as GM or as a player. */
export function tableHref(campaignId: string, role: 'gm' | 'player', user: { id: string; name: string }): string {
  const params = new URLSearchParams({ campaignId, role, playerId: user.id, playerName: user.name });
  return `/vtt-app/index.html?${params.toString()}`;
}

/** The old Quick room link: no campaign, the page asks for a code or creates a room. */
export function quickRoomHref(user: { id: string; name: string }): string {
  const params = new URLSearchParams({ playerId: user.id, playerName: user.name });
  return `/vtt-app/index.html?${params.toString()}`;
}

/** Only the primary DM and the co-DM may open a table as GM; the seat itself is decided by the server. */
export function canOpenAsGm(role: CampaignRole | null): boolean {
  return role === 'dm' || role === 'co_dm';
}
