import { query } from '$lib/server/db';
import { CampaignError } from '$lib/server/campaignError';
import { cachedReference, invalidateReferenceData } from '$lib/server/cache/referenceData';
import { getCampaignAccess, getCharacterAccess, isUuid, type Queryable } from '$lib/server/services/access';
import {
  canAuthorMechanics, canReference, enabledLibraryOwners, isVisibleForNewUse,
  type EntryFacts, type VisibleScope
} from '$lib/library/rules';
import type { ContentType } from '$lib/types/content';

// Server side of the homebrew library (plans/dndchar/homebrew-library, unit A). These helpers load the facts and
// hand them to the pure rules in $lib/library/rules.ts. Remember the core rule: visibility gates NEW USE only.
// Nothing here may be used to hide something a character already holds.
//
// Every function takes a `db` (the pool or a transaction client) so the checks can run inside the same
// transaction as the write they guard.

/** The entry exists but is not offered to this viewer (or is the wrong type). Actions turn this into a 400, not a crash. */
export class ContentNotAvailableError extends CampaignError {}

/** Where a visible scope is worked out from: a character's campaign, a campaign, or just the viewer (their own pages). */
export type ScopeTarget = { characterId?: string; campaignId?: string };

export type LibraryActor = { userId: string; isAdmin: boolean; dmCampaignCount: number; canAuthorMechanics: boolean };

/** Site admin flag plus how many live campaigns the user is DM or co-DM of. Mechanics rights come from these. */
export async function loadLibraryActor(db: Queryable, userId: string): Promise<LibraryActor> {
  if (!isUuid(userId)) throw new CampaignError('User not found.');
  const result = await db.query(
    `SELECT (u.role = 'admin') AS is_admin,
       (SELECT count(*) FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
         WHERE m.user_id = u.id AND m.role IN ('dm', 'co_dm') AND NOT c.is_archived)::int AS dm_count
     FROM users u WHERE u.id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) throw new CampaignError('User not found.');
  const isAdmin = Boolean(row.is_admin);
  const dmCampaignCount = Number(row.dm_count);
  return { userId, isAdmin, dmCampaignCount, canAuthorMechanics: canAuthorMechanics({ isAdmin, dmCampaignCount }) };
}

export type CampaignLibraries = {
  memberIds: string[];
  /** Members whose library the DM has switched on (no row = off). */
  enabledOwnerIds: string[];
  settings: Array<{ ownerUserId: string; isEnabled: boolean }>;
};

export async function loadCampaignLibraries(db: Queryable, campaignId: string): Promise<CampaignLibraries> {
  if (!isUuid(campaignId)) return { memberIds: [], enabledOwnerIds: [], settings: [] };
  const members = await db.query('SELECT user_id FROM campaign_members WHERE campaign_id = $1', [campaignId]);
  const rows = await db.query('SELECT owner_user_id, is_enabled FROM campaign_library_settings WHERE campaign_id = $1', [campaignId]);
  const memberIds: string[] = members.rows.map((row) => row.user_id);
  const settings = rows.rows.map((row) => ({ ownerUserId: row.owner_user_id as string, isEnabled: Boolean(row.is_enabled) }));
  return { memberIds, enabledOwnerIds: enabledLibraryOwners(memberIds, settings), settings };
}

/**
 * The visible set for one viewer, uncached (the add, enable and fork checks use this).
 *  - { characterId }: the character's live campaign, or just the character owner's library when it has none.
 *  - { campaignId }: that campaign (viewer must be able to view it).
 *  - neither: the viewer's own library (their own pages).
 * Giving both is a mistake. Refuses with the same message for a missing or unviewable target.
 */
export async function resolveVisibleScope(db: Queryable, userId: string, target: ScopeTarget = {}): Promise<VisibleScope> {
  if (target.characterId && target.campaignId) throw new CampaignError('Give a character or a campaign, not both.');

  let campaignId: string | null = null;
  let libraryOwnerIfNoCampaign = userId;
  if (target.characterId) {
    const access = await getCharacterAccess(db, userId, target.characterId);
    if (!access?.canView) throw new CampaignError('Character not found.');
    const character = (await db.query(
      `SELECT c.owner_user_id, c.campaign_id, cp.is_archived FROM characters c
       LEFT JOIN campaigns cp ON cp.id = c.campaign_id WHERE c.id = $1`, [target.characterId])).rows[0];
    // A character in an archived campaign counts as campaign-less.
    campaignId = character.campaign_id && !character.is_archived ? character.campaign_id : null;
    libraryOwnerIfNoCampaign = character.owner_user_id;
  } else if (target.campaignId) {
    const access = await getCampaignAccess(db, userId, target.campaignId);
    if (!access?.canView) throw new CampaignError('Campaign not found.');
    campaignId = target.campaignId;
  }

  if (!campaignId) {
    // No campaign: global plus the owner's own library (the viewer's, or the character owner's).
    return { campaignId: null, ownerIds: [libraryOwnerIfNoCampaign], hiddenOkOwnerIds: [libraryOwnerIfNoCampaign], hiddenOkCampaign: false };
  }

  const access = await getCampaignAccess(db, userId, campaignId);
  const libraries = await loadCampaignLibraries(db, campaignId);
  const manager = Boolean(access?.canManage);
  return {
    campaignId,
    ownerIds: libraries.enabledOwnerIds,
    // The campaign's DMs and admins see every owner's hidden entries; anyone else sees only their own.
    hiddenOkOwnerIds: manager ? libraries.enabledOwnerIds : libraries.enabledOwnerIds.filter((id) => id === userId),
    hiddenOkCampaign: manager
  };
}

const SCOPE_TTL_MS = 60_000;

/** The same, cached for 60 s (pickers and search). Library setting changes and forks clear it via invalidateReferenceData. */
export function getCachedVisibleScope(userId: string, target: ScopeTarget = {}): Promise<VisibleScope> {
  const key = `library-scope:${userId}:${target.characterId ?? ''}:${target.campaignId ?? ''}`;
  return cachedReference(key, () => resolveVisibleScope({ query }, userId, target), { ttlMs: SCOPE_TTL_MS });
}

// ---------------------------------------------------------------- checks

type FactsRow = EntryFacts & { id: string };

async function loadFacts(db: Queryable, contentId: string): Promise<FactsRow | null> {
  if (!isUuid(contentId)) return null;
  const row = (await db.query(
    `SELECT id, content_type, scope, owner_user_id, campaign_id, hidden_from_players, is_archived
     FROM content_definitions WHERE id = $1`, [contentId])).rows[0];
  if (!row) return null;
  return {
    id: row.id, type: row.content_type, scope: row.scope, ownerUserId: row.owner_user_id, campaignId: row.campaign_id,
    hiddenFromPlayers: row.hidden_from_players, isArchived: row.is_archived
  };
}

/**
 * Throws unless this entry may be offered or added now (scope, enabled library, hidden flag, not archived), and,
 * if given, is one of the expected types. Use inside the write's transaction with an UNCACHED scope.
 * Says "not found" either way so a refusal never reveals someone else's private entry.
 */
export async function assertVisibleForNewUse(db: Queryable, contentId: string, scope: VisibleScope, expectedTypes?: ContentType[]): Promise<EntryFacts> {
  const facts = await loadFacts(db, contentId);
  if (!facts || (expectedTypes && !expectedTypes.includes(facts.type)) || !isVisibleForNewUse(facts, scope)) {
    throw new ContentNotAvailableError('Catalogue entry not found.');
  }
  return facts;
}

/** Throws unless the source entry may point at the target (grant, spell access, action effect, deck condition key). */
export async function assertReferenceAllowed(db: Queryable, sourceContentId: string, targetContentId: string): Promise<void> {
  const source = await loadFacts(db, sourceContentId);
  const target = await loadFacts(db, targetContentId);
  if (!source || !target) throw new CampaignError('Catalogue entry not found.');
  // A campaign entry may use conditions from libraries enabled in its campaign.
  const enabled = source.scope === 'campaign' && source.campaignId ? (await loadCampaignLibraries(db, source.campaignId)).enabledOwnerIds : [];
  if (!canReference(source, target, enabled)) {
    throw new CampaignError('That entry cannot be used here: it belongs to a different library or campaign.');
  }
}

/** The acting user's own personal entry (scope personal and owner = actor). Admin is not an exception here. */
export async function assertOwnedLibraryEntry(db: Queryable, actor: { userId: string }, contentId: string): Promise<EntryFacts> {
  const facts = await loadFacts(db, contentId);
  if (!facts || facts.scope !== 'personal' || facts.ownerUserId !== actor.userId) throw new CampaignError('Library entry not found.');
  return facts;
}

/** A campaign-scope entry of this campaign, and the user may manage that live campaign. */
export async function assertCampaignEntry(db: Queryable, userId: string, campaignId: string, contentId: string): Promise<EntryFacts> {
  const access = await getCampaignAccess(db, userId, campaignId);
  if (!access?.canManage) throw new CampaignError('Campaign not found.');
  if (access.archived) throw new CampaignError('This campaign is archived.');
  const facts = await loadFacts(db, contentId);
  if (!facts || facts.scope !== 'campaign' || facts.campaignId !== campaignId) throw new CampaignError('Campaign entry not found.');
  return facts;
}

export type Holders = { characters: number; findTables: number; campaigns: number; decks: number };

/** Who depends on an entry, for the owner's "Held by N characters, ..." note. Counts only; nothing is hidden by it. */
export async function countHolders(db: Queryable, contentId: string): Promise<Holders> {
  if (!isUuid(contentId)) return { characters: 0, findTables: 0, campaigns: 0, decks: 0 };
  const row = (await db.query(
    `SELECT
       (SELECT count(*) FROM (
          SELECT character_id FROM character_inventory_items WHERE source_content_id = $1
          UNION SELECT character_id FROM character_content_instances WHERE content_id = $1
          UNION SELECT character_id FROM active_character_effects WHERE container_id = $1
        ) held)::int AS characters,
       (SELECT count(DISTINCT find_table_id) FROM find_table_entries WHERE item_id = $1)::int AS find_tables,
       (SELECT count(*) FROM campaign_decks WHERE deck_content_id = $1)::int AS campaigns,
       -- Decks that name this condition in their rules (stored by content_key, not id). Matched quoted so condition:x does not match condition:x2.
       (SELECT count(*) FROM deck_definitions d, content_definitions me
         WHERE me.id = $1 AND me.content_type = 'condition' AND position('"' || me.content_key || '"' in d.rules_json::text) > 0)::int AS decks`,
    [contentId])).rows[0];
  return { characters: row.characters, findTables: row.find_tables, campaigns: row.campaigns, decks: row.decks };
}

/**
 * Switches a member's library on or off in a campaign. Needs canManage on a live campaign, and the owner must be
 * a current member. Off does not remove anything already in use (visibility gates new use only).
 */
export async function setCampaignLibrary(userId: string, campaignId: string, ownerUserId: string, enabled: boolean): Promise<void> {
  const access = await getCampaignAccess({ query }, userId, campaignId);
  if (!access?.canManage) throw new CampaignError('Campaign not found.');
  if (access.archived) throw new CampaignError('This campaign is archived, so its libraries can no longer be changed.');
  if (!isUuid(ownerUserId)) throw new CampaignError('That person is not a member of this campaign.');
  const member = await query('SELECT 1 FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [campaignId, ownerUserId]);
  if (!member.rows.length) throw new CampaignError('That person is not a member of this campaign.');
  await query(
    `INSERT INTO campaign_library_settings (campaign_id, owner_user_id, is_enabled, updated_by_user_id, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (campaign_id, owner_user_id) DO UPDATE SET is_enabled = EXCLUDED.is_enabled, updated_by_user_id = EXCLUDED.updated_by_user_id, updated_at = now()`,
    [campaignId, ownerUserId, enabled, userId]);
  invalidateReferenceData('library:setting');
}

// ---------------------------------------------------------------- SQL form of the visible set

/**
 * The same rule as isVisibleForNewUse, as a SQL predicate, for list queries (not archived is the caller's job).
 * `alias` is the content_definitions alias; `firstParam` is the number of the first of the FOUR parameters this uses.
 * Append `params` to the query's parameter list at that position.
 */
export function visibleScopeSql(alias: string, scope: VisibleScope, firstParam: number): { sql: string; params: unknown[] } {
  const [campaign, owners, hiddenOwners, hiddenCampaign] = [firstParam, firstParam + 1, firstParam + 2, firstParam + 3];
  const sql = `(${alias}.scope = 'global'
    OR (${alias}.scope = 'campaign' AND ${alias}.campaign_id = $${campaign}::uuid AND (NOT ${alias}.hidden_from_players OR $${hiddenCampaign}::boolean))
    OR (${alias}.scope = 'personal' AND ${alias}.owner_user_id = ANY($${owners}::uuid[])
        AND (NOT ${alias}.hidden_from_players OR ${alias}.owner_user_id = ANY($${hiddenOwners}::uuid[]))))`;
  return { sql, params: [scope.campaignId, scope.ownerIds, scope.hiddenOkOwnerIds, scope.hiddenOkCampaign] };
}

// ---------------------------------------------------------------- campaign library page (unit D)

export type CampaignLibraryMember = {
  userId: string;
  displayName: string;
  role: string;
  /** Switched on by the DM (no settings row = off). */
  enabled: boolean;
  /**
   * Live (not archived) personal entries by tab. Hidden-from-players entries are counted for managers only.
   * null when the library is off and the viewer is neither a manager nor the owner (matches the View link's 404).
   */
  counts: { item: number; spell: number; feat: number; total: number } | null;
};

/**
 * The members of a campaign with the state of each one's library. Anyone who can view the campaign may read it;
 * only canManage gets the switches (the route checks that). Returns null when the viewer cannot see the campaign.
 */
export async function loadCampaignLibraryPage(db: Queryable, userId: string, campaignId: string) {
  const access = isUuid(campaignId) ? await getCampaignAccess(db, userId, campaignId) : null;
  if (!access?.canView) return null;
  const campaign = (await db.query('SELECT name FROM campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!campaign) return null;
  const libraries = await loadCampaignLibraries(db, campaignId);
  const rows = await db.query(
    `SELECT m.user_id, m.role, u.display_name,
       count(c.id) FILTER (WHERE c.content_type = 'item')::int AS items,
       count(c.id) FILTER (WHERE c.content_type = 'spell')::int AS spells,
       count(c.id) FILTER (WHERE c.content_type IN ('feat', 'class_feature'))::int AS feats
     FROM campaign_members m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN content_definitions c ON c.scope = 'personal' AND c.owner_user_id = m.user_id AND NOT c.is_archived
       AND c.content_type IN ('item', 'spell', 'feat', 'class_feature') AND (NOT c.hidden_from_players OR $2::boolean OR c.owner_user_id = $3::uuid)
     WHERE m.campaign_id = $1
     GROUP BY m.user_id, m.role, u.display_name
     ORDER BY CASE m.role WHEN 'dm' THEN 0 WHEN 'co_dm' THEN 1 ELSE 2 END, lower(u.display_name)`,
    [campaignId, access.canManage, userId]);
  const members: CampaignLibraryMember[] = rows.rows.map((row) => ({
    userId: row.user_id, displayName: row.display_name, role: row.role,
    enabled: libraries.enabledOwnerIds.includes(row.user_id),
    counts: libraries.enabledOwnerIds.includes(row.user_id) || access.canManage || row.user_id === userId
      ? { item: row.items, spell: row.spells, feat: row.feats, total: row.items + row.spells + row.feats } : null
  }));
  return { campaignId, campaignName: campaign.name as string, archived: access.archived, canManage: access.canManage, members };
}
