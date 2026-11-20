import type { CampaignRole } from '$lib/types/campaign';
import { CampaignError } from '$lib/server/campaignError';

// Who may see, edit or act for a character, and who may manage a campaign's members.
//
// The decision functions at the top are pure (no DB) so the rules are unit-tested in access.test.ts.
// The loaders at the bottom fetch the facts with one query each and feed them in.
//
// Site admin is an OVERRIDE, never a campaign role: it is never counted as a DM and is never the
// GM in the VTT just for being admin. Admin can view and edit, but does not "act" (no rolls on
// someone's behalf); that stays with the owner and the DMs.

export type { CampaignRole };

export type AccessFacts = {
  userId: string;
  isAdmin: boolean;
  ownerUserId: string;
  campaignId: string | null;
  campaignArchived: boolean;
  /** The viewer's role in the character's campaign (null = not a member, or no campaign). */
  memberRole: CampaignRole | null;
};

export type CharacterAccess = {
  canView: boolean;
  canEdit: boolean;
  canAct: boolean;
  isOwner: boolean;
  isCampaignDm: boolean;
  /** True when the EDIT right exists only because of the admin override (a plain member can view, not edit). */
  viaAdmin: boolean;
};

/** Primary DM or co-DM. */
export function isDmRole(role: CampaignRole | null | undefined): boolean {
  return role === 'dm' || role === 'co_dm';
}

export function decideCharacterAccess(facts: AccessFacts): CharacterAccess {
  const isOwner = facts.ownerUserId === facts.userId;
  // An archived campaign stops granting anything to its members (its characters are released
  // anyway); the owner and admin keep their own access regardless.
  const live = Boolean(facts.campaignId) && !facts.campaignArchived;
  const isMember = live && facts.memberRole !== null;
  const isCampaignDm = live && isDmRole(facts.memberRole);
  return {
    canView: isOwner || facts.isAdmin || isMember,
    canEdit: isOwner || facts.isAdmin || isCampaignDm,
    // Kept separate from canEdit on purpose: stand-in play will widen THIS later, never canEdit.
    // Excludes admin (an override is not the player) and plain members (viewers can't roll).
    canAct: isOwner || isCampaignDm,
    isOwner,
    isCampaignDm,
    viaAdmin: facts.isAdmin && !(isOwner || isCampaignDm)
  };
}

export type CampaignAccess = { canView: boolean; canManage: boolean; isDm: boolean; isPrimaryDm: boolean };

export function decideCampaignAccess(facts: { isAdmin: boolean; memberRole: CampaignRole | null; archived: boolean }): CampaignAccess {
  const live = !facts.archived;
  return {
    canView: facts.isAdmin || (live && facts.memberRole !== null),
    // Settings, invite code, removing people and characters.
    canManage: facts.isAdmin || (live && isDmRole(facts.memberRole)),
    // The REAL role only: admin is never a DM.
    isDm: isDmRole(facts.memberRole),
    isPrimaryDm: facts.memberRole === 'dm'
  };
}

// ---------------------------------------------------------------------------------------------
// Membership rules (pure). `roles` is the role of every current member of the campaign, so the
// "one co-DM" slot can be checked without a query.
// ---------------------------------------------------------------------------------------------

export type Actor = { userId: string; role: CampaignRole | null; isAdmin: boolean };
export type Target = { userId: string; role: CampaignRole };
type Denied = { ok: false; reason: string };

export function canSetRole(
  actor: Actor,
  target: Target,
  newRole: CampaignRole,
  roles: CampaignRole[]
): { ok: true; demoteOldPrimaryTo?: 'co_dm' | 'player' } | Denied {
  if (newRole === target.role) return { ok: false, reason: 'They already have that role.' };
  const coDmTaken = roles.includes('co_dm');
  const hasPrimary = roles.includes('dm');

  if (actor.isAdmin) {
    if (newRole === 'dm') {
      // Old primary steps down to co-DM if that slot is free (or is the one the target is leaving).
      if (!hasPrimary) return { ok: true };
      const slotFree = !coDmTaken || target.role === 'co_dm';
      return { ok: true, demoteOldPrimaryTo: slotFree ? 'co_dm' : 'player' };
    }
    // Demoting the primary would leave a campaign with no DM (and maybe a co-DM but no primary).
    if (target.role === 'dm') return { ok: false, reason: 'Make someone else the primary DM instead.' };
    if (newRole === 'co_dm' && coDmTaken) return { ok: false, reason: 'This campaign already has a co-DM.' };
    return { ok: true };
  }

  // Only the primary DM changes roles, and never their own (that's Leave).
  if (actor.role !== 'dm') return { ok: false, reason: 'Only the DM can change roles.' };
  if (target.userId === actor.userId || target.role === 'dm') return { ok: false, reason: "You can't change the DM's role." };
  // The primary may swap with the EXISTING co-DM (old primary becomes co-DM). A non-admin can't
  // hand the primary role to anyone else.
  if (newRole === 'dm') {
    return target.role === 'co_dm'
      ? { ok: true, demoteOldPrimaryTo: 'co_dm' }
      : { ok: false, reason: 'You can only hand the DM role to your co-DM.' };
  }
  if (newRole === 'co_dm' && coDmTaken) return { ok: false, reason: 'This campaign already has a co-DM.' };
  return { ok: true };
}

export function canRemoveMember(actor: Actor, target: Target, roles: CampaignRole[]): { ok: true; promoteCoDm?: boolean } | Denied {
  // Removing yourself is Leave, which has its own rules.
  if (target.userId === actor.userId) return { ok: false, reason: 'Use Leave campaign to remove yourself.' };
  // Removing the primary DM hands the seat to the co-DM, if there is one.
  const promoteCoDm = target.role === 'dm' && roles.includes('co_dm');
  if (actor.isAdmin) return promoteCoDm ? { ok: true, promoteCoDm } : { ok: true };
  if (actor.role === 'dm') return { ok: true };
  if (actor.role === 'co_dm') {
    // The co-DM can't touch the primary DM (or, being the only co-DM, anyone else of equal rank).
    return target.role === 'player' ? { ok: true } : { ok: false, reason: "A co-DM can't remove the DM." };
  }
  return { ok: false, reason: 'Only a DM can remove people.' };
}

export function canLeave(self: Target, roles: CampaignRole[], archived = false): { ok: true; promoteCoDm?: boolean } | Denied {
  // Anyone may leave a dead (archived) campaign, so no membership gets stuck there.
  if (archived || self.role !== 'dm') return { ok: true };
  // The primary DM leaving hands over to the co-DM. With none they can't leave, admin or not: a
  // campaign is never left with no DM through Leave (admin manages without being a member).
  if (roles.includes('co_dm')) return { ok: true, promoteCoDm: true };
  return { ok: false, reason: 'Hand over or archive the campaign instead.' };
}

// ---------------------------------------------------------------------------------------------
// DB loaders. They take a Queryable so the same helper works with the pool and, inside a
// transaction, with a PoolClient.
// ---------------------------------------------------------------------------------------------

export type Queryable = { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> };

// A malformed id must read as "not found", not blow up with Postgres 22P02.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

/** null = no such character (or no such user). */
export async function getCharacterAccess(db: Queryable, userId: string, characterId: string): Promise<CharacterAccess | null> {
  if (!isUuid(userId) || !isUuid(characterId)) return null;
  const result = await db.query(
    `
      SELECT c.owner_user_id, c.campaign_id, cp.is_archived, m.role AS member_role, (u.role = 'admin') AS is_admin
      FROM characters c
      JOIN users u ON u.id = $2
      LEFT JOIN campaigns cp ON cp.id = c.campaign_id
      LEFT JOIN campaign_members m ON m.campaign_id = c.campaign_id AND m.user_id = $2
      WHERE c.id = $1
    `,
    [characterId, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return decideCharacterAccess({
    userId,
    isAdmin: Boolean(row.is_admin),
    ownerUserId: row.owner_user_id,
    campaignId: row.campaign_id,
    campaignArchived: Boolean(row.is_archived),
    memberRole: row.member_role ?? null
  });
}

// All three throw the same message, so a failed check never reveals whether the character exists.
async function assertCharacter(db: Queryable, userId: string, characterId: string, flag: 'canView' | 'canEdit' | 'canAct'): Promise<CharacterAccess> {
  const access = await getCharacterAccess(db, userId, characterId);
  if (!access || !access[flag]) throw new CampaignError('Character not found.');
  return access;
}
export const assertCanViewCharacter = (db: Queryable, userId: string, characterId: string) => assertCharacter(db, userId, characterId, 'canView');
export const assertCanEditCharacter = (db: Queryable, userId: string, characterId: string) => assertCharacter(db, userId, characterId, 'canEdit');
export const assertCanActForCharacter = (db: Queryable, userId: string, characterId: string) => assertCharacter(db, userId, characterId, 'canAct');

export type LoadedCampaignAccess = CampaignAccess & { role: CampaignRole | null; isAdmin: boolean; archived: boolean };

/** null = no such campaign (or no such user). */
export async function getCampaignAccess(db: Queryable, userId: string, campaignId: string): Promise<LoadedCampaignAccess | null> {
  if (!isUuid(userId) || !isUuid(campaignId)) return null;
  const result = await db.query(
    `
      SELECT cp.is_archived, m.role AS member_role, (u.role = 'admin') AS is_admin
      FROM campaigns cp
      JOIN users u ON u.id = $2
      LEFT JOIN campaign_members m ON m.campaign_id = cp.id AND m.user_id = $2
      WHERE cp.id = $1
    `,
    [campaignId, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const role: CampaignRole | null = row.member_role ?? null;
  const isAdmin = Boolean(row.is_admin);
  const archived = Boolean(row.is_archived);
  return { ...decideCampaignAccess({ isAdmin, memberRole: role, archived }), role, isAdmin, archived };
}

/** Real DM role only: admin is excluded on purpose. */
export async function isCampaignDm(db: Queryable, userId: string, campaignId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(campaignId)) return false;
  const result = await db.query(
    `SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2 AND role IN ('dm', 'co_dm')`,
    [campaignId, userId]
  );
  return result.rows.length > 0;
}
