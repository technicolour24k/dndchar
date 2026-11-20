import { canLeave, canRemoveMember, canSetRole, type CampaignRole } from '$lib/server/services/access';

// Which member controls to SHOW on the campaign page. Built from the same rules the service
// enforces (access.ts), so the buttons match what will be allowed. This is only for display: every
// action re-checks on the server.

export type Viewer = { userId: string; role: CampaignRole | null; isAdmin: boolean };
export type MemberRow = { userId: string; role: CampaignRole };

export type MemberControls = {
  makeCoDm: boolean;
  makePlayer: boolean;
  // Primary DM swapping with the co-DM ("Hand over DM role"), or an admin choosing the primary.
  makePrimary: boolean;
  remove: boolean;
  // Who the old primary becomes if this member is made primary (for the confirm text).
  demoteOldPrimaryTo: 'co_dm' | 'player' | null;
};

export function memberControls(viewer: Viewer, members: MemberRow[], archived: boolean): Record<string, MemberControls> {
  const roles = members.map((m) => m.role);
  const out: Record<string, MemberControls> = {};
  for (const target of members) {
    const controls: MemberControls = { makeCoDm: false, makePlayer: false, makePrimary: false, remove: false, demoteOldPrimaryTo: null };
    out[target.userId] = controls;
    // Archived campaigns are read-only history for everyone.
    if (archived) continue;
    // Nobody changes or removes themselves here (that is Leave), with one exception: an admin who
    // joined as a player can make themselves primary DM (how a campaign with no DM gets one).
    if (target.userId === viewer.userId) {
      if (viewer.isAdmin) {
        const self = canSetRole({ userId: viewer.userId, role: viewer.role, isAdmin: true }, { userId: target.userId, role: target.role }, 'dm', roles);
        controls.makePrimary = self.ok;
        controls.demoteOldPrimaryTo = self.ok ? (self.demoteOldPrimaryTo ?? null) : null;
      }
      continue;
    }
    const actor = { userId: viewer.userId, role: viewer.role, isAdmin: viewer.isAdmin };
    const asTarget = { userId: target.userId, role: target.role };
    const primary = canSetRole(actor, asTarget, 'dm', roles);
    controls.makeCoDm = canSetRole(actor, asTarget, 'co_dm', roles).ok;
    controls.makePlayer = canSetRole(actor, asTarget, 'player', roles).ok;
    controls.makePrimary = primary.ok;
    controls.demoteOldPrimaryTo = primary.ok ? (primary.demoteOldPrimaryTo ?? null) : null;
    controls.remove = canRemoveMember(actor, asTarget, roles).ok;
  }
  return out;
}

/** Leave button state for the viewer, plus the "co-DM takes over" note when it applies. */
export function leaveState(
  viewer: Viewer,
  members: MemberRow[],
  archived: boolean
): { show: boolean; allowed: boolean; reason: string; coDmInherits: boolean } {
  if (!viewer.role) return { show: false, allowed: false, reason: '', coDmInherits: false };
  const verdict = canLeave({ userId: viewer.userId, role: viewer.role }, members.map((m) => m.role), archived);
  return verdict.ok
    ? { show: true, allowed: true, reason: '', coDmInherits: Boolean(verdict.promoteCoDm) }
    : { show: true, allowed: false, reason: verdict.reason, coDmInherits: false };
}
