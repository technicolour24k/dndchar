import crypto from 'node:crypto';
import { CampaignError } from '$lib/server/campaignError';
import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { canLeave, canRemoveMember, canSetRole, decideCampaignAccess, getCampaignAccess, isUuid, type LoadedCampaignAccess } from '$lib/server/services/access';
import type {
  Campaign,
  CampaignCharacter,
  CampaignCharacterGroup,
  CampaignCharacterOption,
  CampaignListPage,
  CampaignMember,
  CampaignRole,
  CampaignSummary
} from '$lib/types/campaign';
import type { CharacterClass } from '$lib/types/character';

// Campaign service. Every function takes the acting user id and throws a user-facing Error when
// something isn't allowed; permission rules live in access.ts. Writes run in a transaction that
// locks the campaign's member rows first, so two people changing roles at once can't both win.
// Nothing here hard-deletes a campaign: they are archived.

export const CAMPAIGNS_PAGE_SIZE = 12;
const MAX_PAGE = 100000;

// Same alphabet as the VTT room codes (no I, O, 0, 1), so codes are easy to read out loud.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateCode(length: number): string {
  let code = '';
  for (let i = 0; i < length; i += 1) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
  return code;
}

/** Uppercases and drops spaces and hyphens, so "abcde-fghjk" works. */
export function normaliseCode(input: string): string {
  return String(input ?? '').toUpperCase().replace(/[\s-]+/g, '');
}

const INVITE_LENGTH = 10;
const ROOM_LENGTH = 8;

function uniqueViolation(error: unknown, names: string[]): boolean {
  const e = error as { code?: string; constraint?: string };
  return e?.code === '23505' && names.includes(e.constraint ?? '');
}

// A code clash rolls the whole transaction back, so retry the whole thing (not one statement).
async function withCodeRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      if (attempt < 5 && uniqueViolation(error, ['campaigns_invite_code_key', 'campaigns_room_code_key'])) continue;
      throw error;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------------------------

type Member = { userId: string; role: CampaignRole };
type Locked = { campaign: { id: string; roomCode: string; isArchived: boolean }; isAdmin: boolean; members: Member[] };

// Loads the campaign and its members (locking the member rows) plus whether the actor is admin.
async function lockCampaign(client: pg.PoolClient, userId: string, campaignId: string): Promise<Locked> {
  if (!isUuid(campaignId) || !isUuid(userId)) throw new CampaignError('Campaign not found.');
  const campaign = await client.query<{ id: string; room_code: string; is_archived: boolean }>(
    'SELECT id, room_code, is_archived FROM campaigns WHERE id = $1',
    [campaignId]
  );
  if (!campaign.rows[0]) throw new CampaignError('Campaign not found.');
  const members = await client.query<{ user_id: string; role: CampaignRole }>(
    'SELECT user_id, role FROM campaign_members WHERE campaign_id = $1 FOR UPDATE',
    [campaignId]
  );
  const admin = await client.query<{ is_admin: boolean }>("SELECT (role = 'admin') AS is_admin FROM users WHERE id = $1", [userId]);
  return {
    campaign: { id: campaign.rows[0].id, roomCode: campaign.rows[0].room_code, isArchived: campaign.rows[0].is_archived },
    isAdmin: Boolean(admin.rows[0]?.is_admin),
    members: members.rows.map((row) => ({ userId: row.user_id, role: row.role }))
  };
}

const roleOf = (locked: Locked, userId: string): CampaignRole | null => locked.members.find((m) => m.userId === userId)?.role ?? null;

// Only admin may touch an archived campaign.
function assertNotArchived(locked: Locked) {
  if (locked.campaign.isArchived && !locked.isAdmin) throw new CampaignError('This campaign is archived.');
}

// A user leaving (or being removed): their characters leave the campaign and, if their sheet was
// joined to this campaign's room, that join is cleared.
async function releaseMember(client: pg.PoolClient, campaignId: string, roomCode: string, userId: string) {
  await client.query(
    'UPDATE characters SET campaign_id = NULL, party_active = true WHERE owner_user_id = $1 AND campaign_id = $2',
    [userId, campaignId]
  );
  await client.query('UPDATE users SET active_vtt_session_id = NULL WHERE id = $1 AND active_vtt_session_id = $2', [userId, roomCode]);
  await client.query('DELETE FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [campaignId, userId]);
}

function checkDetails(name: string, description: string) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new CampaignError('Give the campaign a name.');
  if (trimmed.length > 80) throw new CampaignError('The name can be at most 80 characters.');
  if (String(description ?? '').length > 2000) throw new CampaignError('The description can be at most 2000 characters.');
  return { name: trimmed, description: String(description ?? '') };
}

// ---------------------------------------------------------------------------------------------
// Campaigns
// ---------------------------------------------------------------------------------------------

// Any signed-in user. The creator becomes the primary DM.
export async function createCampaign(userId: string, name: string, description = ''): Promise<string> {
  const details = checkDetails(name, description);
  return withCodeRetry(() =>
    withTransaction(async (client) => {
      const created = await client.query<{ id: string }>(
        `INSERT INTO campaigns (name, description, invite_code, room_code, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [details.name, details.description, generateCode(INVITE_LENGTH), generateCode(ROOM_LENGTH), userId]
      );
      await client.query(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'dm')`, [created.rows[0].id, userId]);
      return created.rows[0].id;
    })
  );
}

// Anyone signed in; they only see what they may. Non-admins see the non-archived campaigns they
// belong to. Admins see every campaign (archived ones only with includeArchived).
export async function listCampaigns(
  userId: string,
  opts: { q?: string; page?: number; includeArchived?: boolean } = {}
): Promise<CampaignListPage> {
  const q = String(opts.q ?? '').trim().slice(0, 80);
  const includeArchived = Boolean(opts.includeArchived);
  // Escape LIKE wildcards so a "%" or "_" typed in the box is matched literally.
  const escaped = q.replace(/[\\%_]/g, '\\$&');
  // Capped so a silly page number can't overflow OFFSET (the past-the-end fallback does the rest).
  const requested = Number.isFinite(opts.page) ? Math.min(MAX_PAGE, Math.max(1, Math.floor(opts.page as number))) : 1;

  const run = (offset: number) =>
    query<{
      id: string; name: string; is_archived: boolean; my_role: CampaignRole | null;
      member_count: number; character_count: number; dm_name: string | null; total: number;
    }>(
      `
        SELECT cp.id, cp.name, cp.is_archived, m.role AS my_role,
          (SELECT count(*)::int FROM campaign_members WHERE campaign_id = cp.id) AS member_count,
          (SELECT count(*)::int FROM characters WHERE campaign_id = cp.id) AS character_count,
          (SELECT du.display_name FROM campaign_members d JOIN users du ON du.id = d.user_id
            WHERE d.campaign_id = cp.id AND d.role = 'dm') AS dm_name,
          (COUNT(*) OVER ())::int AS total
        FROM campaigns cp
        JOIN users u ON u.id = $1
        LEFT JOIN campaign_members m ON m.campaign_id = cp.id AND m.user_id = $1
        WHERE (u.role = 'admin' OR m.user_id IS NOT NULL)
          AND (cp.is_archived = false OR (u.role = 'admin' AND $3::boolean))
          AND lower(cp.name) LIKE '%' || lower($2) || '%' ESCAPE '\\'
        ORDER BY lower(cp.name), cp.created_at, cp.id
        LIMIT ${CAMPAIGNS_PAGE_SIZE} OFFSET $4
      `,
      [userId, escaped, includeArchived, offset]
    );

  let page = requested;
  let result = await run((page - 1) * CAMPAIGNS_PAGE_SIZE);
  let total = result.rows[0]?.total ?? 0;
  // An out-of-range page has no rows to carry the total, so count once and show the last page.
  if (!result.rows.length && page > 1) {
    const counted = await run(0);
    total = counted.rows[0]?.total ?? 0;
    page = Math.max(1, Math.ceil(total / CAMPAIGNS_PAGE_SIZE));
    result = page === 1 ? counted : await run((page - 1) * CAMPAIGNS_PAGE_SIZE);
  }
  const pageCount = Math.max(1, Math.ceil(total / CAMPAIGNS_PAGE_SIZE));
  const items: CampaignSummary[] = result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    myRole: row.my_role,
    isArchived: row.is_archived,
    memberCount: row.member_count,
    characterCount: row.character_count,
    dmName: row.dm_name
  }));
  return { items, total, page, pageCount, q, includeArchived };
}

export type CampaignPage = {
  campaign: Omit<Campaign, 'inviteCode'> & { inviteCode: string | null };
  access: LoadedCampaignAccess;
  members: CampaignMember[];
  characters: CampaignCharacter[];
  myCharacters: CampaignCharacterOption[];
};

// Members and admin only (null otherwise). The invite code is only included for DMs and admin.
export async function getCampaignPage(userId: string, campaignId: string): Promise<CampaignPage | null> {
  const access = await getCampaignAccess({ query }, userId, campaignId);
  if (!access || !access.canView) return null;

  const campaignRow = await query<{
    id: string; name: string; description: string; invite_code: string; room_code: string;
    created_by_user_id: string | null; is_archived: boolean; created_at: string;
  }>('SELECT id, name, description, invite_code, room_code, created_by_user_id, is_archived, created_at FROM campaigns WHERE id = $1', [campaignId]);
  const c = campaignRow.rows[0];
  if (!c) return null;

  const memberRows = await query<{ user_id: string; display_name: string; role: CampaignRole; joined_at: string }>(
    `SELECT m.user_id, u.display_name, m.role, m.joined_at
     FROM campaign_members m JOIN users u ON u.id = m.user_id
     WHERE m.campaign_id = $1
     ORDER BY CASE m.role WHEN 'dm' THEN 0 WHEN 'co_dm' THEN 1 ELSE 2 END, lower(u.display_name)`,
    [campaignId]
  );

  const characterRows = await query<{ id: string; name: string; owner_user_id: string; owner_name: string; party_active: boolean }>(
    `SELECT c.id, c.name, c.owner_user_id, u.display_name AS owner_name, c.party_active
     FROM characters c JOIN users u ON u.id = c.owner_user_id
     WHERE c.campaign_id = $1
     ORDER BY lower(c.name), c.id`,
    [campaignId]
  );
  const ids = characterRows.rows.map((row) => row.id);
  const classRows = ids.length
    ? await query<{ character_id: string; class_name: string; level: number; subclass_name: string }>(
        'SELECT character_id, class_name, level, subclass_name FROM character_classes WHERE character_id = ANY($1::uuid[]) ORDER BY sort_order ASC',
        [ids]
      )
    : { rows: [] as { character_id: string; class_name: string; level: number; subclass_name: string }[] };
  const hpRows = ids.length
    ? await query<{ character_id: string; current_value: number; max_value: number }>(
        `SELECT character_id, current_value, max_value FROM character_resources WHERE resource_key = 'hp' AND character_id = ANY($1::uuid[])`,
        [ids]
      )
    : { rows: [] as { character_id: string; current_value: number; max_value: number }[] };

  const characters: CampaignCharacter[] = characterRows.rows.map((row) => {
    const classes: CharacterClass[] = classRows.rows
      .filter((cl) => cl.character_id === row.id)
      .map((cl) => ({ className: cl.class_name, level: cl.level, subclassName: cl.subclass_name }));
    const hp = hpRows.rows.find((r) => r.character_id === row.id);
    return {
      id: row.id,
      name: row.name,
      ownerUserId: row.owner_user_id,
      ownerName: row.owner_name,
      partyActive: row.party_active,
      classes,
      hpCurrent: hp?.current_value ?? 0,
      hpMax: hp?.max_value ?? 0
    };
  });

  // The user's own characters and where they are now, for the "add your character" picker.
  const mine = await query<{ id: string; name: string; campaign_id: string | null; campaign_name: string | null }>(
    `SELECT c.id, c.name, c.campaign_id, cp.name AS campaign_name
     FROM characters c LEFT JOIN campaigns cp ON cp.id = c.campaign_id
     WHERE c.owner_user_id = $1 ORDER BY lower(c.name), c.id`,
    [userId]
  );

  return {
    campaign: {
      id: c.id,
      name: c.name,
      description: c.description,
      inviteCode: access.canManage ? c.invite_code : null,
      roomCode: c.room_code,
      createdByUserId: c.created_by_user_id,
      isArchived: c.is_archived,
      createdAt: c.created_at
    },
    access,
    members: memberRows.rows.map((row) => ({ userId: row.user_id, displayName: row.display_name, role: row.role, joinedAt: row.joined_at })),
    characters,
    myCharacters: mine.rows.map((row) => ({ id: row.id, name: row.name, campaignId: row.campaign_id, campaignName: row.campaign_name }))
  };
}

// Other people's characters in the live campaigns the user is a member of, grouped by campaign, for
// the roster's "Campaign characters". Membership only (an admin gets their own memberships too; the
// full set is reachable through /campaigns). A member can open all of these in the read-only sheet.
export async function listCampaignCharactersForUser(userId: string): Promise<CampaignCharacterGroup[]> {
  const rows = await query<{
    id: string; name: string; ancestry: string; background: string; system_key: string; updated_at: string;
    party_active: boolean; campaign_id: string; campaign_name: string; owner_name: string;
  }>(
    `SELECT c.id, c.name, c.ancestry, c.background, c.system_key, c.updated_at, c.party_active,
            cp.id AS campaign_id, cp.name AS campaign_name, u.display_name AS owner_name
     FROM campaign_members m
     JOIN campaigns cp ON cp.id = m.campaign_id AND NOT cp.is_archived
     JOIN characters c ON c.campaign_id = cp.id AND c.owner_user_id <> $1
     JOIN users u ON u.id = c.owner_user_id
     WHERE m.user_id = $1
     ORDER BY lower(cp.name), cp.id, lower(c.name), c.id`,
    [userId]
  );
  if (rows.rows.length === 0) return [];

  const ids = rows.rows.map((row) => row.id);
  const classRows = await query<{ character_id: string; class_name: string; level: number; subclass_name: string }>(
    'SELECT character_id, class_name, level, subclass_name FROM character_classes WHERE character_id = ANY($1::uuid[]) ORDER BY sort_order ASC',
    [ids]
  );
  const hpRows = await query<{ character_id: string; current_value: number; max_value: number }>(
    `SELECT character_id, current_value, max_value FROM character_resources WHERE resource_key = 'hp' AND character_id = ANY($1::uuid[])`,
    [ids]
  );

  // Index by character id, so each row is O(1) rather than a scan of every class / HP row.
  const classesById = new Map<string, CharacterClass[]>();
  for (const cl of classRows.rows) {
    const list = classesById.get(cl.character_id) ?? [];
    list.push({ className: cl.class_name, level: cl.level, subclassName: cl.subclass_name });
    classesById.set(cl.character_id, list);
  }
  const hpById = new Map(hpRows.rows.map((r) => [r.character_id, r]));

  const groups: CampaignCharacterGroup[] = [];
  for (const row of rows.rows) {
    let group = groups[groups.length - 1];
    if (!group || group.campaignId !== row.campaign_id) {
      group = { campaignId: row.campaign_id, campaignName: row.campaign_name, characters: [] };
      groups.push(group);
    }
    const hp = hpById.get(row.id);
    group.characters.push({
      id: row.id,
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      partyActive: row.party_active,
      name: row.name,
      ancestry: row.ancestry,
      background: row.background,
      systemKey: row.system_key,
      classes: classesById.get(row.id) ?? [],
      hpCurrent: hp?.current_value ?? 0,
      hpMax: hp?.max_value ?? 0,
      updatedAt: row.updated_at,
      ownerName: row.owner_name
    });
  }
  return groups;
}

// The user's own live campaigns (not archived), for the sheet's campaign picker. Unpaged: it is a
// select box of the campaigns one person actually plays in.
export async function listMyCampaignOptions(userId: string): Promise<{ id: string; name: string }[]> {
  const result = await query<{ id: string; name: string }>(
    `SELECT cp.id, cp.name FROM campaigns cp JOIN campaign_members m ON m.campaign_id = cp.id
     WHERE m.user_id = $1 AND cp.is_archived = false ORDER BY lower(cp.name), cp.id`,
    [userId]
  );
  return result.rows;
}

// Public to any signed-in user holding the code (the invite page shows it before joining).
export async function findCampaignByInviteCode(code: string): Promise<{ id: string; name: string; dmName: string | null } | null> {
  const normalised = normaliseCode(code);
  if (!normalised) return null;
  const result = await query<{ id: string; name: string; dm_name: string | null }>(
    `SELECT cp.id, cp.name,
       (SELECT u.display_name FROM campaign_members d JOIN users u ON u.id = d.user_id WHERE d.campaign_id = cp.id AND d.role = 'dm') AS dm_name
     FROM campaigns cp WHERE cp.invite_code = $1 AND cp.is_archived = false`,
    [normalised]
  );
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, dmName: row.dm_name } : null;
}

// Any signed-in user with a valid code. Idempotent: an existing member keeps their role. The
// campaign row is read FOR SHARE so a concurrent archive (which updates it) can't slip in between
// the archived check and the insert.
export async function joinCampaignByInviteCode(userId: string, code: string): Promise<string> {
  const normalised = normaliseCode(code);
  return withTransaction(async (client) => {
    const found = normalised
      ? await client.query<{ id: string }>('SELECT id FROM campaigns WHERE invite_code = $1 AND is_archived = false FOR SHARE', [normalised])
      : { rows: [] as { id: string }[] };
    if (!found.rows[0]) throw new CampaignError("That invite code wasn't found.");
    await client.query(
      `INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, 'player') ON CONFLICT (campaign_id, user_id) DO NOTHING`,
      [found.rows[0].id, userId]
    );
    return found.rows[0].id;
  });
}

// DMs and admin. The old code stops working straight away.
export async function regenerateInviteCode(userId: string, campaignId: string): Promise<string> {
  return withCodeRetry(() =>
    withTransaction(async (client) => {
      const locked = await lockCampaign(client, userId, campaignId);
      const access = decideCampaignAccess({ isAdmin: locked.isAdmin, memberRole: roleOf(locked, userId), archived: locked.campaign.isArchived });
      if (!access.canManage) throw new CampaignError("You can't manage this campaign.");
      const code = generateCode(INVITE_LENGTH);
      await client.query('UPDATE campaigns SET invite_code = $2, updated_at = now() WHERE id = $1', [campaignId, code]);
      return code;
    })
  );
}

// DMs and admin.
export async function updateCampaignDetails(userId: string, campaignId: string, name: string, description: string): Promise<void> {
  const details = checkDetails(name, description);
  await withTransaction(async (client) => {
    const locked = await lockCampaign(client, userId, campaignId);
    const access = decideCampaignAccess({ isAdmin: locked.isAdmin, memberRole: roleOf(locked, userId), archived: locked.campaign.isArchived });
    if (!access.canManage) throw new CampaignError("You can't manage this campaign.");
    await client.query('UPDATE campaigns SET name = $2, description = $3, updated_at = now() WHERE id = $1', [campaignId, details.name, details.description]);
  });
}

// ---------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------

// Rules in canSetRole. The DB's partial unique indexes are the backstop for two simultaneous
// promotions, so a 23505 on them is turned into the friendly message.
// Returns the room code and the users this change dropped to a plain player, so the caller can
// kick them from the live room (they reconnect with a ticket for their new role).
export async function setMemberRole(
  userId: string,
  campaignId: string,
  targetUserId: string,
  role: CampaignRole
): Promise<{ roomCode: string; demotedToPlayer: string[] }> {
  try {
    return await withTransaction(async (client) => {
      const locked = await lockCampaign(client, userId, campaignId);
      assertNotArchived(locked);
      const targetRole = roleOf(locked, targetUserId);
      if (!targetRole) throw new CampaignError('That person is not in this campaign.');
      const roles = locked.members.map((m) => m.role);
      const verdict = canSetRole({ userId, role: roleOf(locked, userId), isAdmin: locked.isAdmin }, { userId: targetUserId, role: targetRole }, role, roles);
      if (!verdict.ok) throw new CampaignError(verdict.reason);

      const set = (id: string, to: CampaignRole) =>
        client.query('UPDATE campaign_members SET role = $3 WHERE campaign_id = $1 AND user_id = $2', [campaignId, id, to]);
      if (role === 'dm') {
        // Order matters so the unique indexes never see two rows with one role: park the target as
        // a player (frees its old slot), step the old primary down, then seat the target.
        const oldPrimary = locked.members.find((m) => m.role === 'dm');
        await set(targetUserId, 'player');
        if (oldPrimary && verdict.demoteOldPrimaryTo) await set(oldPrimary.userId, verdict.demoteOldPrimaryTo);
      }
      await set(targetUserId, role);
      await client.query('UPDATE campaigns SET updated_at = now() WHERE id = $1', [campaignId]);
      const demotedToPlayer: string[] = [];
      if (role === 'player') demotedToPlayer.push(targetUserId);
      const oldPrimaryId = locked.members.find((m) => m.role === 'dm')?.userId;
      if (role === 'dm' && oldPrimaryId && verdict.demoteOldPrimaryTo === 'player') demotedToPlayer.push(oldPrimaryId);
      return { roomCode: locked.campaign.roomCode, demotedToPlayer };
    });
  } catch (error) {
    if (uniqueViolation(error, ['campaign_members_one_co_dm_idx'])) throw new CampaignError('This campaign already has a co-DM.');
    if (uniqueViolation(error, ['campaign_members_one_dm_idx'])) throw new CampaignError('This campaign already has a DM.');
    throw error;
  }
}

// Rules in canRemoveMember. Returns the room code and user so the caller can kick live sockets
// (the campaign page action does, via campaignRooms.ts).
export async function removeMember(userId: string, campaignId: string, targetUserId: string): Promise<{ roomCode: string; targetUserId: string }> {
  return withTransaction(async (client) => {
    const locked = await lockCampaign(client, userId, campaignId);
    assertNotArchived(locked);
    const targetRole = roleOf(locked, targetUserId);
    if (!targetRole) throw new CampaignError('That person is not in this campaign.');
    const verdict = canRemoveMember(
      { userId, role: roleOf(locked, userId), isAdmin: locked.isAdmin },
      { userId: targetUserId, role: targetRole },
      locked.members.map((m) => m.role)
    );
    if (!verdict.ok) throw new CampaignError(verdict.reason);
    // Delete first so the 'dm' slot is free for the co-DM to take.
    await releaseMember(client, campaignId, locked.campaign.roomCode, targetUserId);
    if (verdict.promoteCoDm) {
      await client.query(`UPDATE campaign_members SET role = 'dm' WHERE campaign_id = $1 AND role = 'co_dm'`, [campaignId]);
    }
    return { roomCode: locked.campaign.roomCode, targetUserId };
  });
}

// Any member, for themselves. Rules in canLeave (the last DM can't leave; a primary DM with a
// co-DM hands over to them).
export async function leaveCampaign(userId: string, campaignId: string): Promise<{ roomCode: string }> {
  return withTransaction(async (client) => {
    const locked = await lockCampaign(client, userId, campaignId);
    const myRole = roleOf(locked, userId);
    if (!myRole) throw new CampaignError("You're not in this campaign.");
    const verdict = canLeave({ userId, role: myRole }, locked.members.map((m) => m.role), locked.campaign.isArchived);
    if (!verdict.ok) throw new CampaignError(verdict.reason);
    await releaseMember(client, campaignId, locked.campaign.roomCode, userId);
    if (verdict.promoteCoDm) {
      await client.query(`UPDATE campaign_members SET role = 'dm' WHERE campaign_id = $1 AND role = 'co_dm'`, [campaignId]);
    }
    return { roomCode: locked.campaign.roomCode };
  });
}

// ---------------------------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------------------------

// LOCK ORDER (everywhere): the campaign's member rows first, then the character row.
// removeMember, leaveCampaign and archiveCampaign already lock members before updating
// characters, so the character paths below do the same; the opposite order could deadlock.

// The character's owner, who must be a member of the target campaign. A character already in
// another campaign moves (the UI confirms first). One campaign per character is the single column.
export async function addCharacterToCampaign(userId: string, characterId: string, campaignId: string): Promise<void> {
  await withTransaction(async (client) => {
    if (!isUuid(characterId)) throw new CampaignError('Character not found.');
    const locked = await lockCampaign(client, userId, campaignId);
    const character = await client.query<{ owner_user_id: string }>('SELECT owner_user_id FROM characters WHERE id = $1 FOR UPDATE', [characterId]);
    if (!character.rows[0] || character.rows[0].owner_user_id !== userId) throw new CampaignError('Character not found.');
    if (!roleOf(locked, userId)) throw new CampaignError('Join the campaign before adding a character.');
    if (locked.campaign.isArchived) throw new CampaignError('This campaign is archived.');
    await client.query('UPDATE characters SET campaign_id = $2, party_active = true WHERE id = $1', [characterId, campaignId]);
  });
}

// Loads the character's campaign and decides whether the user may manage it: the owner always
// may, otherwise a DM of its campaign or admin. Follows the lock order above: peek at the
// character without a lock to find its campaign, lock that campaign, then lock the character and
// check it hasn't moved in between.
async function loadCharacterForCampaignChange(client: pg.PoolClient, userId: string, characterId: string, expectedCampaignId?: string) {
  if (!isUuid(characterId)) throw new CampaignError('Character not found.');
  const peek = await client.query<{ campaign_id: string | null }>('SELECT campaign_id FROM characters WHERE id = $1', [characterId]);
  if (!peek.rows[0]) throw new CampaignError('Character not found.');
  const campaignId = peek.rows[0].campaign_id;
  if (!campaignId) throw new CampaignError('That character is not in a campaign.');
  // The campaign page passes its own id, so a stale or forged form can't act on another campaign's character.
  if (expectedCampaignId && campaignId !== expectedCampaignId) throw new CampaignError('That character is not in this campaign.');
  const locked = await lockCampaign(client, userId, campaignId);
  const row = await client.query<{ owner_user_id: string; campaign_id: string | null }>(
    'SELECT owner_user_id, campaign_id FROM characters WHERE id = $1 FOR UPDATE',
    [characterId]
  );
  const character = row.rows[0];
  if (!character) throw new CampaignError('Character not found.');
  if (character.campaign_id !== campaignId) throw new CampaignError("That character's campaign just changed, try again.");
  const isOwner = character.owner_user_id === userId;
  const access = decideCampaignAccess({ isAdmin: locked.isAdmin, memberRole: roleOf(locked, userId), archived: locked.campaign.isArchived });
  if (!isOwner && !access.canManage) throw new CampaignError('Character not found.');
  return campaignId;
}

// Owner, or a DM of its campaign, or admin.
export async function removeCharacterFromCampaign(userId: string, characterId: string, expectedCampaignId?: string): Promise<void> {
  await withTransaction(async (client) => {
    await loadCharacterForCampaignChange(client, userId, characterId, expectedCampaignId);
    await client.query('UPDATE characters SET campaign_id = NULL, party_active = true WHERE id = $1', [characterId]);
  });
}

// Owner, or a DM of its campaign, or admin. Inactive characters stay in the campaign; the flag
// only affects grouping and which characters the VTT GM picker offers.
export async function setCharacterPartyActive(userId: string, characterId: string, active: boolean, expectedCampaignId?: string): Promise<void> {
  await withTransaction(async (client) => {
    await loadCharacterForCampaignChange(client, userId, characterId, expectedCampaignId);
    await client.query('UPDATE characters SET party_active = $2 WHERE id = $1', [characterId, Boolean(active)]);
  });
}

// ---------------------------------------------------------------------------------------------
// Archive and lookup
// ---------------------------------------------------------------------------------------------

// Primary DM or admin. Stops the invite code and table, releases every character, and clears
// members' sheet joins to the room. Member rows and game sessions stay for history. The caller
// closes the live room (campaignRooms.ts closeCampaignRoom).
export async function archiveCampaign(userId: string, campaignId: string): Promise<{ roomCode: string }> {
  return withTransaction(async (client) => {
    const locked = await lockCampaign(client, userId, campaignId);
    if (locked.campaign.isArchived) throw new CampaignError('This campaign is already archived.');
    if (!locked.isAdmin && roleOf(locked, userId) !== 'dm') throw new CampaignError('Only the DM can archive this campaign.');
    await client.query('UPDATE campaigns SET is_archived = true, updated_at = now() WHERE id = $1', [campaignId]);
    await client.query('UPDATE characters SET campaign_id = NULL, party_active = true WHERE campaign_id = $1', [campaignId]);
    // The table is gone, so its running game session ends with it (nothing could end it later).
    await client.query('UPDATE game_sessions SET is_active = false, updated_at = now() WHERE campaign_id = $1 AND is_active', [campaignId]);
    await client.query(
      `UPDATE users SET active_vtt_session_id = NULL
       WHERE active_vtt_session_id = $2 AND id IN (SELECT user_id FROM campaign_members WHERE campaign_id = $1)`,
      [campaignId, locked.campaign.roomCode]
    );
    return { roomCode: locked.campaign.roomCode };
  });
}

// Used by the VTT server routes to tell a campaign room from a Quick room.
// Returns the canonical room code too (typed codes are normalised, so "abcd-efgh" matches), which
// is what callers must use for the room and for users.active_vtt_session_id.
export async function getCampaignByRoomCode(roomCode: string): Promise<{ id: string; isArchived: boolean; roomCode: string } | null> {
  const result = await query<{ id: string; is_archived: boolean; room_code: string }>('SELECT id, is_archived, room_code FROM campaigns WHERE room_code = $1', [normaliseCode(roomCode)]);
  const row = result.rows[0];
  return row ? { id: row.id, isArchived: row.is_archived, roomCode: row.room_code } : null;
}
