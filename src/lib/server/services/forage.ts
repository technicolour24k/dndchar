import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { cachedReference, invalidateReferenceData } from '$lib/server/cache/referenceData';
import {
  DEFAULT_CHANCE, findCheckSummary, parseEntryInput, parseTableInput, pickableEntries, rollFind, shapeFindForViewer, validateFindLines,
  type FindForViewer, type RollDie, type SessionFindView
} from '$lib/rules/forage';
import { insertCatalogueItem } from '$lib/server/services/catalogue';
import { isCampaignDm } from '$lib/server/services/access';
import { assertVisibleForNewUse, loadCampaignLibraries, resolveVisibleScope } from '$lib/server/services/library';
import { forageSourceLabel, type LibraryScope } from '$lib/library/rules';
import type {
  FindLine, FindMode, FindResult, FindStatus, FindTable, FindTableEntry, ForageCatalogue, ForageCatalogueTable, ForageCheck
} from '$lib/types/forage';

// Find tables (forage / loot finder). A table only points at existing item Containers and grants no
// mechanics. Every table belongs to exactly one campaign (migration 037, campaign system Unit G).
// There are no shared tables: a campaign with no active table that has something pickable has
// foraging disabled. Editing is for the primary DM or co-DM of the table's campaign, plus site
// admins. The author (owner_user_id) is provenance only and grants nothing.

/**
 * The bits of the signed-in user the permission check needs. dmCampaignIds are the campaigns where
 * they are the primary DM or co-DM (real roles: admin is not a DM, it has its own override).
 */
export type ForageActor = { id: string; role: 'user' | 'admin'; dmCampaignIds: string[] };

type TableRow = {
  id: string; campaign_id: string; campaign_name: string | null; name: string; area_type: string; category: string; suggested_check: string;
  is_archived: boolean; owner_user_id: string | null; owner_name: string | null;
  entry_count: number; pickable_count: number;
};

type EntryRow = {
  find_table_id: string; item_id: string; item_name: string; item_category: string | null;
  chance: number; qty_die: number; sort_order: number; item_archived: boolean;
};

function mapTable(row: TableRow): FindTable {
  return {
    id: row.id, campaignId: row.campaign_id, campaignName: row.campaign_name ?? '', name: row.name, areaType: row.area_type, category: row.category,
    suggestedCheck: row.suggested_check, isArchived: row.is_archived, ownerUserId: row.owner_user_id,
    ownerName: row.owner_name, entryCount: row.entry_count, pickableCount: row.pickable_count
  };
}

function mapEntry(row: EntryRow): FindTableEntry {
  return {
    itemId: row.item_id, itemName: row.item_name, itemCategory: row.item_category ?? 'gear', chance: row.chance,
    qtyDie: row.qty_die, itemArchived: row.item_archived, sortOrder: row.sort_order
  };
}

const ENTRY_SELECT = `
  SELECT e.find_table_id, e.item_id, c.name AS item_name, i.category AS item_category, e.chance, e.qty_die,
         e.sort_order, c.is_archived AS item_archived
  FROM find_table_entries e
  JOIN content_definitions c ON c.id = e.item_id
  LEFT JOIN item_definitions i ON i.content_id = c.id`;

/**
 * The signed-in user as a ForageActor: their role plus the campaigns they are a real DM of (primary
 * or co-DM, archived campaigns excluded). One small query.
 */
export async function loadForageActor(user: { id: string; role: 'user' | 'admin' }): Promise<ForageActor> {
  const result = await query<{ campaign_id: string }>(
    `SELECT m.campaign_id FROM campaign_members m JOIN campaigns c ON c.id = m.campaign_id
     WHERE m.user_id = $1 AND m.role IN ('dm', 'co_dm') AND NOT c.is_archived`, [user.id]
  );
  return { id: user.id, role: user.role, dmCampaignIds: result.rows.map((row) => row.campaign_id) };
}

/** The campaigns this actor may add tables to: their DM campaigns, or every live campaign for an admin. */
export async function listEditableCampaigns(actor: ForageActor): Promise<Array<{ id: string; name: string }>> {
  const result = await query<{ id: string; name: string }>(
    `SELECT id, name FROM campaigns WHERE NOT is_archived AND ($1::boolean OR id = ANY($2::uuid[])) ORDER BY lower(name), created_at`,
    [actor.role === 'admin', actor.dmCampaignIds]
  );
  return result.rows;
}

/** How many active tables a campaign has (the campaign page's "Find tables: N active" line). */
export async function countActiveFindTables(campaignId: string): Promise<number> {
  if (!UUID_PATTERN.test(campaignId)) return 0;
  const result = await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM find_tables WHERE campaign_id = $1 AND NOT is_archived', [campaignId]);
  return result.rows[0]?.count ?? 0;
}

/**
 * Every table (archived included) with counts, for the authoring page, but only the ones this actor
 * may edit: their DM campaigns' tables, or all of them for an admin. The authoring page is
 * DM-only, so a player never sees a table name here.
 */
export async function listFindTables(actor: ForageActor): Promise<FindTable[]> {
  const result = await query<TableRow>(`
    SELECT t.id, t.campaign_id, cp.name AS campaign_name, t.name, t.area_type, t.category, t.suggested_check, t.is_archived,
           t.owner_user_id, u.display_name AS owner_name,
           COUNT(e.item_id)::int AS entry_count,
           COUNT(e.item_id) FILTER (WHERE e.chance > 0 AND NOT c.is_archived)::int AS pickable_count
    FROM find_tables t
    JOIN campaigns cp ON cp.id = t.campaign_id
    LEFT JOIN users u ON u.id = t.owner_user_id
    LEFT JOIN find_table_entries e ON e.find_table_id = t.id
    LEFT JOIN content_definitions c ON c.id = e.item_id
    WHERE $1::boolean OR t.campaign_id = ANY($2::uuid[])
    GROUP BY t.id, cp.name, u.display_name
    ORDER BY lower(cp.name), t.area_type, t.category, t.name`, [actor.role === 'admin', actor.dmCampaignIds]);
  return result.rows.map(mapTable);
}

// Authoring view: each entry also says where its item came from (see forageSourceLabel). Works out "enabled" from
// the table's campaign, so an item from a library that has since been switched off reads "not enabled here".
export async function getFindTableEntries(tableId: string): Promise<FindTableEntry[]> {
  const result = await query<EntryRow & { scope: LibraryScope; owner_user_id: string | null; owner_name: string | null; fork_name: string | null; table_campaign: string }>(
    `SELECT e.find_table_id, e.item_id, c.name AS item_name, i.category AS item_category, e.chance, e.qty_die,
            e.sort_order, c.is_archived AS item_archived, c.scope, c.owner_user_id, u.display_name AS owner_name,
            c.metadata_json->'fork'->>'fromOwnerName' AS fork_name, t.campaign_id AS table_campaign
     FROM find_table_entries e
     JOIN find_tables t ON t.id = e.find_table_id
     JOIN content_definitions c ON c.id = e.item_id
     LEFT JOIN item_definitions i ON i.content_id = c.id
     LEFT JOIN users u ON u.id = c.owner_user_id
     WHERE e.find_table_id = $1 ORDER BY e.sort_order, c.name`, [tableId]);
  if (!result.rows.length) return [];
  const { enabledOwnerIds } = await loadCampaignLibraries({ query }, result.rows[0].table_campaign);
  return result.rows.map((row) => ({
    ...mapEntry(row),
    sourceLabel: forageSourceLabel({
      scope: row.scope, ownerName: row.owner_name, ownerEnabled: row.owner_user_id !== null && enabledOwnerIds.includes(row.owner_user_id), forkedFromOwnerName: row.fork_name
    })
  }));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The service's own permission gate: a DM of the table's campaign, or an admin. Throws a user-facing
// Error. A malformed id is "not found" rather than Postgres's raw 22P02 text.
async function requireEditableTable(actor: ForageActor, tableId: string): Promise<void> {
  if (!UUID_PATTERN.test(tableId)) throw new Error('Find table not found.');
  const result = await query<{ campaign_id: string }>('SELECT campaign_id FROM find_tables WHERE id = $1', [tableId]);
  if (!result.rowCount) throw new Error('Find table not found.');
  if (!canEditFindTable(actor, { campaignId: result.rows[0].campaign_id })) {
    throw new Error("Only a DM of this table's campaign can edit it.");
  }
}

/** Admin, or the primary DM / co-DM of the table's campaign. The original author no longer matters. */
export function canEditFindTable(actor: ForageActor, table: Pick<FindTable, 'campaignId'>): boolean {
  return actor.role === 'admin' || actor.dmCampaignIds.includes(table.campaignId);
}

/**
 * Adds canEdit to each table and blanks suggestedCheck for anyone who can't edit it (Q9: only the
 * campaign's DMs and admins see that DM-side reminder in authoring).
 */
export function tablesForActor(actor: ForageActor, tables: FindTable[]): (FindTable & { canEdit: boolean })[] {
  return tables.map((table) => {
    const canEdit = canEditFindTable(actor, table);
    return { ...table, canEdit, suggestedCheck: canEdit ? table.suggestedCheck : '' };
  });
}

/**
 * The DM-side suggested check for one table. The cached catalogue deliberately leaves it out, so
 * callers that may show it (the room's GM in unit B) must check their own permission, then use this.
 */
export async function getSuggestedCheck(tableId: string): Promise<string> {
  if (!UUID_PATTERN.test(tableId)) return '';
  const result = await query<{ suggested_check: string }>('SELECT suggested_check FROM find_tables WHERE id = $1', [tableId]);
  return result.rows[0]?.suggested_check ?? '';
}

// 23505 on the one-active-table-per-campaign+area+category index becomes a friendly message.
function friendlyTableError(error: unknown, areaType: string, category: string, campaignName = 'this campaign'): Error {
  if ((error as { code?: string })?.code === '23505') {
    return new Error(`There's already an active table for ${areaType} + ${category} in ${campaignName}.`);
  }
  return error instanceof Error ? error : new Error('Could not save the find table.');
}

export async function createFindTable(actor: ForageActor, form: FormData): Promise<string> {
  const input = parseTableInput({
    name: form.get('name'), areaType: form.get('areaType'), category: form.get('category'),
    suggestedCheck: form.get('suggestedCheck')
  });
  // The table goes into one campaign the actor is a DM of (any live campaign for an admin).
  const campaignId = String(form.get('campaignId') || '');
  if (!UUID_PATTERN.test(campaignId)) throw new Error('Pick a campaign for this table.');
  if (!canEditFindTable(actor, { campaignId })) throw new Error('You can only add tables to campaigns you are a DM of.');
  const campaign = await query<{ name: string; is_archived: boolean }>('SELECT name, is_archived FROM campaigns WHERE id = $1', [campaignId]);
  if (!campaign.rowCount || campaign.rows[0].is_archived) throw new Error('That campaign was not found.');
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO find_tables (name, area_type, category, suggested_check, owner_user_id, campaign_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.name, input.areaType, input.category, input.suggestedCheck, actor.id, campaignId]
    );
    invalidateReferenceData('forage:create-table');
    return result.rows[0].id;
  } catch (error) {
    throw friendlyTableError(error, input.areaType, input.category, campaign.rows[0].name);
  }
}

export async function updateFindTable(actor: ForageActor, form: FormData): Promise<string> {
  const tableId = String(form.get('tableId') || '');
  await requireEditableTable(actor, tableId);
  const input = parseTableInput({
    name: form.get('name'), areaType: form.get('areaType'), category: form.get('category'),
    suggestedCheck: form.get('suggestedCheck')
  });
  try {
    await query(
      `UPDATE find_tables SET name = $2, area_type = $3, category = $4, suggested_check = $5,
         updated_at = now() WHERE id = $1`,
      [tableId, input.name, input.areaType, input.category, input.suggestedCheck]
    );
  } catch (error) {
    throw friendlyTableError(error, input.areaType, input.category);
  }
  invalidateReferenceData('forage:update-table');
  return tableId;
}

/** Archive or restore. Restoring can hit the one-active-table rule, which gets the friendly error. */
export async function toggleFindTableArchived(actor: ForageActor, form: FormData): Promise<string> {
  const tableId = String(form.get('tableId') || '');
  await requireEditableTable(actor, tableId);
  try {
    await query('UPDATE find_tables SET is_archived = NOT is_archived, updated_at = now() WHERE id = $1', [tableId]);
  } catch (error) {
    const row = await query<{ area_type: string; category: string }>('SELECT area_type, category FROM find_tables WHERE id = $1', [tableId]);
    throw friendlyTableError(error, row.rows[0]?.area_type ?? '', row.rows[0]?.category ?? '');
  }
  invalidateReferenceData('forage:archive-table');
  return tableId;
}

/** Adds an item to a table. The item must be a live item Container, and not already on the table. */
export async function addFindTableEntry(actor: ForageActor, form: FormData): Promise<string> {
  const tableId = String(form.get('tableId') || '');
  await requireEditableTable(actor, tableId);
  const itemId = String(form.get('itemId') || '');
  if (!itemId) throw new Error('Pick an item to add.');
  const { chance, qtyDie } = parseEntryInput({ chance: form.get('chance') ?? DEFAULT_CHANCE, qtyDie: form.get('qtyDie') || 1 });

  // Postgres can't CHECK across tables, so the "is an item Container" rule lives here.
  if (!UUID_PATTERN.test(itemId)) throw new Error('That is not an item.');
  const item = await query<{ is_archived: boolean }>(
    "SELECT is_archived FROM content_definitions WHERE id = $1 AND content_type = 'item'", [itemId]
  );
  if (!item.rowCount) throw new Error('That is not an item.');
  if (item.rows[0].is_archived) throw new Error('That item is archived and cannot be added.');
  // Homebrew library: only items this table's campaign may be OFFERED (global, enabled libraries, its own copies).
  // Items already on the table keep working whatever happens to the library (this gates new additions only).
  const tableCampaign = (await query<{ campaign_id: string }>('SELECT campaign_id FROM find_tables WHERE id = $1', [tableId])).rows[0].campaign_id;
  await assertVisibleForNewUse({ query }, itemId, await resolveVisibleScope({ query }, actor.id, { campaignId: tableCampaign }), ['item']);

  // Never overwrite a tuned entry: a repeat add is refused (edit it in the entries list instead).
  const added = await query(
    `INSERT INTO find_table_entries (find_table_id, item_id, chance, qty_die, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 1 FROM find_table_entries WHERE find_table_id = $1), 0))
     ON CONFLICT (find_table_id, item_id) DO NOTHING`,
    [tableId, itemId, chance, qtyDie]
  );
  if (!added.rowCount) throw new Error('That item is already on this table.');
  await query('UPDATE find_tables SET updated_at = now() WHERE id = $1', [tableId]);
  invalidateReferenceData('forage:add-entry');
  return tableId;
}

/** Saves chance and qty die for every entry on the page in one go (fields entryItem/chance/qtyDie, repeated). */
export async function updateFindTableEntries(actor: ForageActor, form: FormData): Promise<string> {
  const tableId = String(form.get('tableId') || '');
  await requireEditableTable(actor, tableId);
  const itemIds = form.getAll('entryItem').map(String);
  const chances = form.getAll('chance');
  const qtyDice = form.getAll('qtyDie');
  // Validate everything before writing anything.
  if (!itemIds.every((id) => UUID_PATTERN.test(id))) throw new Error('Item not found.');
  const parsed = itemIds.map((itemId, index) => ({ itemId, ...parseEntryInput({ chance: chances[index], qtyDie: qtyDice[index] }) }));
  await withTransaction(async (client) => {
    for (const entry of parsed) {
      await client.query(
        'UPDATE find_table_entries SET chance = $3, qty_die = $4 WHERE find_table_id = $1 AND item_id = $2',
        [tableId, entry.itemId, entry.chance, entry.qtyDie]
      );
    }
    await client.query('UPDATE find_tables SET updated_at = now() WHERE id = $1', [tableId]);
  });
  invalidateReferenceData('forage:save-entries');
  return tableId;
}

export async function removeFindTableEntry(actor: ForageActor, form: FormData): Promise<string> {
  const tableId = String(form.get('tableId') || '');
  await requireEditableTable(actor, tableId);
  const itemId = String(form.get('itemId') || '');
  if (!UUID_PATTERN.test(itemId)) throw new Error('Item not found.');
  await query('DELETE FROM find_table_entries WHERE find_table_id = $1 AND item_id = $2', [tableId, itemId]);
  await query('UPDATE find_tables SET updated_at = now() WHERE id = $1', [tableId]);
  invalidateReferenceData('forage:remove-entry');
  return tableId;
}

/**
 * Every ACTIVE table with its entries, in two queries, cached. This is what the player pickers and
 * the roll read (units B and C). Archived-item entries are included but flagged, so a table can show
 * "N pickable" honestly. Archived tables are left out.
 *
 * Player-safe by design (Q9): it never carries suggested_check, so it can be sent to any client.
 * The DM-side reminder comes from getSuggestedCheck, behind the caller's own permission check.
 */
export function loadForageCatalogue(): Promise<ForageCatalogue> {
  return cachedReference('forage-catalogue', async () => {
    const tables = await query<TableRow>(`
      SELECT t.id, t.campaign_id, NULL::text AS campaign_name, t.name, t.area_type, t.category, '' AS suggested_check, t.is_archived,
             t.owner_user_id, NULL::text AS owner_name, 0 AS entry_count, 0 AS pickable_count
      FROM find_tables t WHERE t.is_archived = false ORDER BY t.area_type, t.category`);
    const entries = await query<EntryRow>(`${ENTRY_SELECT}
      WHERE e.find_table_id IN (SELECT id FROM find_tables WHERE is_archived = false)
      ORDER BY e.sort_order, c.name`);
    const byTable = new Map<string, FindTableEntry[]>();
    for (const row of entries.rows) {
      const list = byTable.get(row.find_table_id) ?? [];
      list.push(mapEntry(row));
      byTable.set(row.find_table_id, list);
    }
    return {
      tables: tables.rows.map((row) => {
        const list = byTable.get(row.id) ?? [];
        const { ownerName: _ownerName, entryCount: _entryCount, suggestedCheck: _suggestedCheck, campaignName: _campaignName, ...table } = mapTable(row);
        return { ...table, entries: list, pickableCount: list.filter((entry) => entry.chance > 0 && !entry.itemArchived).length };
      })
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Finds: the write paths for forage hauls (unit B).
//
// These are deliberately NOT owner-scoped where a GM or admin acts on a player's character (the
// getCharacterForRoll posture): the endpoints decide who may call them. After any commit that
// changes inventory the caller runs emitRealtimeEvent('character:updated', { characterId }).
// ---------------------------------------------------------------------------------------------

const defaultRollDie: RollDie = (sides) => Math.floor(Math.random() * sides) + 1;

/** A haul line with its item's display name, as shown to the finder and the DM. */
export type NamedFindLine = { itemId: string; name: string; qty: number };

/** One active table (with entries) from the cached catalogue, or null if archived or unknown. */
export async function getActiveTable(tableId: string): Promise<ForageCatalogueTable | null> {
  if (!UUID_PATTERN.test(tableId)) return null;
  const catalogue = await loadForageCatalogue();
  return catalogue.tables.find((table) => table.id === tableId) ?? null;
}

/** Fresh (uncached) entries for some of a table's items, on the transaction's client. */
async function freshEntries(client: pg.PoolClient, tableId: string, itemIds: string[]): Promise<FindTableEntry[]> {
  const result = await client.query<EntryRow>(
    `${ENTRY_SELECT} WHERE e.find_table_id = $1 AND e.item_id = ANY($2::uuid[])`, [tableId, itemIds]
  );
  return result.rows.map(mapEntry);
}

/** Per-row cap, matching addInventoryItem. Stacking never pushes a row past it. */
const MAX_STACK = 999;

/**
 * Q1 (stacking): adds a quantity to the character's existing row for this item, else inserts a new
 * row through the shared catalogue insert path. A row matches when it is the same catalogue item
 * (source_content_id), not equipped, not attuned, and has no custom notes, so a player's customised
 * or worn copy is never touched. The oldest match wins. A row that would pass 999 is skipped (a new
 * row is made instead). Returns the inventory row id that now holds the quantity.
 */
async function addToInventory(client: pg.PoolClient, characterId: string, itemId: string, qty: number): Promise<string> {
  const match = await client.query<{ id: string }>(
    `SELECT id FROM character_inventory_items
     WHERE character_id = $1 AND source_content_id = $2 AND equipped = false AND location <> 'equipped'
       AND attuned = false AND notes = '' AND quantity + $3 <= ${MAX_STACK}
     ORDER BY sort_order, id LIMIT 1 FOR UPDATE`,
    [characterId, itemId, qty]
  );
  if (match.rowCount) {
    await client.query('UPDATE character_inventory_items SET quantity = quantity + $2 WHERE id = $1', [match.rows[0].id, qty]);
    return match.rows[0].id;
  }
  return insertCatalogueItem(client, characterId, itemId, qty);
}

/**
 * Puts a haul into a character's inventory. Re-reads the table's entries fresh and throws if any
 * line's item is no longer on the table or has been archived since the roll (an archive race), which
 * rolls the caller's transaction back. Used by both modes. Returns what was added, per line.
 */
export async function insertFindItems(
  client: pg.PoolClient, input: { characterId: string; tableId: string; lines: FindLine[] }
): Promise<Array<FindResult & { name: string }>> {
  const entries = await freshEntries(client, input.tableId, input.lines.map((line) => line.itemId));
  const byItem = new Map(entries.map((entry) => [entry.itemId, entry]));
  const added: Array<FindResult & { name: string }> = [];
  for (const line of input.lines) {
    const entry = byItem.get(line.itemId);
    if (!entry || entry.itemArchived) throw new Error('An item in this haul is no longer available.');
    const inventoryId = await addToInventory(client, input.characterId, line.itemId, line.qty);
    added.push({ item_id: line.itemId, qty: line.qty, inventory_id: inventoryId, name: entry.itemName });
  }
  return added;
}

function resultsJson(added: Array<FindResult & { name: string }>): string {
  return JSON.stringify(added.map(({ item_id, qty, inventory_id }) => ({ item_id, qty, inventory_id })));
}

/**
 * DM mode: the DM approved a haul. One transaction: items into inventory, then the finds row. The
 * find's campaign is the table's (the route has already checked the table is the room's campaign's).
 */
export async function approveDmFind(input: {
  characterId: string; finderUserId: string; tableId: string; lines: FindLine[]; nat20: boolean;
  check: ForageCheck; gameSessionId: string | null; roomCode: string | null;
}): Promise<{ findId: string; lines: NamedFindLine[] }> {
  return withTransaction(async (client) => {
    const added = await insertFindItems(client, input);
    const row = await client.query<{ id: string }>(
      `INSERT INTO finds (mode, status, game_session_id, room_code, character_id, finder_user_id, find_table_id,
         nat20, check_json, results, resolved_at, campaign_id)
       VALUES ('dm', 'found', $1, $2, $3, $4, $5, $6, $7, $8, now(), (SELECT campaign_id FROM find_tables WHERE id = $5)) RETURNING id`,
      [input.gameSessionId, input.roomCode, input.characterId, input.finderUserId, input.tableId, input.nat20,
        JSON.stringify(input.check), resultsJson(added)]
    );
    return { findId: row.rows[0].id, lines: added.map((a) => ({ itemId: a.item_id, name: a.name, qty: a.qty })) };
  });
}

/** tableId is null for a self-serve forage of an area + category with no table (it can only find nothing). */
export type UnmarkedSelfFind = { findId: string; characterId: string; tableId: string | null; check: ForageCheck; roomCode: string | null };

function mapUnmarked(row: any): UnmarkedSelfFind {
  return { findId: row.id, characterId: row.character_id, tableId: row.find_table_id, check: row.check_json, roomCode: row.room_code };
}

/** The user's unmarked self-serve check, if any (the partial unique index allows at most one). */
export async function getUnmarkedSelfFind(userId: string): Promise<UnmarkedSelfFind | null> {
  const result = await query(
    `SELECT id, character_id, find_table_id, check_json, room_code FROM finds WHERE finder_user_id = $1 AND status = 'checked'`, [userId]
  );
  return result.rows[0] ? mapUnmarked(result.rows[0]) : null;
}

/**
 * Self-serve: logs the rolled check as a 'checked' find. If the user already has an unmarked check
 * (including a racing second start, which trips the partial unique index with 23505) nothing is
 * inserted, and the existing one comes back so the caller can reopen it at the mark step.
 */
export async function startSelfFind(input: {
  characterId: string; finderUserId: string; tableId: string | null; areaType: string; category: string; check: ForageCheck;
  roomCode: string | null; gameSessionId: string | null; campaignId?: string | null;
}): Promise<{ findId: string } | { conflict: 'unmarked_check'; existing: UnmarkedSelfFind | null }> {
  const existing = await getUnmarkedSelfFind(input.finderUserId);
  if (existing) return { conflict: 'unmarked_check', existing };
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO finds (mode, status, game_session_id, room_code, character_id, finder_user_id, find_table_id,
         area_type, category, nat20, check_json, campaign_id)
       VALUES ('self', 'checked', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [input.gameSessionId, input.roomCode, input.characterId, input.finderUserId, input.tableId, input.areaType, input.category,
        input.check.nat20, JSON.stringify(input.check), input.campaignId ?? null]
    );
    return { findId: result.rows[0].id };
  } catch (error) {
    if ((error as { code?: string })?.code === '23505') {
      return { conflict: 'unmarked_check', existing: await getUnmarkedSelfFind(input.finderUserId) };
    }
    throw error;
  }
}

export type MarkedSelfFind = {
  status: 'failed' | 'found';
  characterId: string;
  roomCode: string | null;
  gameSessionId: string | null;
  check: ForageCheck;
  lines: NamedFindLine[];
};

/**
 * Self-serve: the player marks the check pass or fail. A nat 1 forces a fail. A pass rolls the haul
 * (two runs on a nat 20), validates it like a DM's approval, and inserts it, all in one transaction
 * with the find row locked, so a double tap can only ever mark once ('stale' the second time).
 * The table is the one fixed at start (the player never picks or changes it). If there was none (an
 * area + category with no table), or it has since been archived or has nothing pickable, a pass
 * can't pay out, so the find closes as 'failed' with empty results and a note. The player just sees
 * that they found nothing, exactly as for a failed check. A pass on a live table rolls every
 * pickable entry on its own chance, so it can also come up empty: that closes as 'found' with no
 * results (a real pass that found nothing).
 */
export async function markSelfFind(input: {
  findId: string; userId: string; passed: boolean; rollDie?: RollDie;
}): Promise<{ ok: true; result: MarkedSelfFind } | { ok: false; error: 'stale' }> {
  return withTransaction(async (client) => {
    const found = await client.query<any>(
      `SELECT * FROM finds WHERE id = $1 AND finder_user_id = $2 AND status = 'checked' FOR UPDATE`, [input.findId, input.userId]
    );
    const find = found.rows[0];
    if (!find) return { ok: false as const, error: 'stale' as const };
    const check: ForageCheck = find.check_json;
    const base = {
      characterId: find.character_id as string, roomCode: find.room_code as string | null,
      gameSessionId: find.game_session_id as string | null, check
    };

    if (!input.passed || check.nat1) {
      await client.query(`UPDATE finds SET status = 'failed', resolved_at = now() WHERE id = $1`, [find.id]);
      return { ok: true as const, result: { status: 'failed' as const, ...base, lines: [] } };
    }

    const tableId: string | null = find.find_table_id;
    const closeNothingToFind = async (note: string) => {
      await client.query(`UPDATE finds SET status = 'failed', resolved_at = now(), revert_note = $2 WHERE id = $1`, [find.id, note]);
      return { ok: true as const, result: { status: 'failed' as const, ...base, lines: [] } };
    };
    if (!tableId) return closeNothingToFind('No table for this area and category, so there was nothing to find.');
    const gone = 'Table empty or archived at mark time, nothing was added.';
    const table = await client.query('SELECT 1 FROM find_tables WHERE id = $1 AND is_archived = false', [tableId]);
    if (!table.rowCount) return closeNothingToFind(gone);
    const entries = (await client.query<EntryRow>(`${ENTRY_SELECT} WHERE e.find_table_id = $1`, [tableId])).rows.map(mapEntry);
    if (pickableEntries(entries).length === 0) return closeNothingToFind(gone);

    const rolled = rollFind(entries, !!find.nat20, input.rollDie ?? defaultRollDie);
    // The server's own haul goes through the same validator as a DM's approval. An empty haul is fine:
    // the pass found nothing, so the find is logged as 'found' with no results (the player is told
    // "You didn't find anything", the roll log says "found nothing of note").
    const valid = validateFindLines(rolled.lines, entries, undefined, true);
    if (!valid.ok) throw new Error(valid.error);
    const added = await insertFindItems(client, { characterId: find.character_id, tableId, lines: valid.lines });
    await client.query(
      `UPDATE finds SET status = 'found', find_table_id = $2, results = $3, resolved_at = now() WHERE id = $1`,
      [find.id, tableId, resultsJson(added)]
    );
    return {
      ok: true as const,
      result: { status: 'found' as const, ...base, lines: added.map((a) => ({ itemId: a.item_id, name: a.name, qty: a.qty })) }
    };
  });
}

/**
 * Admin undo of a found haul (either mode). Locks the find, then for each result line touches ONLY
 * the inventory row that find wrote to (by id, and only if it is still this character's row of the
 * same item): it reduces it by the quantity the find added, and deletes it when that reaches 0 or
 * below. Anything the player already used, removed or changed is noted rather than guessed at.
 * No other row is ever affected, so an unrelated stack of the same item the player had before stays
 * as it was. The find is kept, marked 'reverted', with the notes. Never hard-deleted.
 */
export async function revertFind(input: { findId: string; adminUserId: string }): Promise<{
  note: string; characterId: string; finderUserId: string; roomCode: string | null; gameSessionId: string | null;
} | null> {
  if (!UUID_PATTERN.test(input.findId)) return null; // a malformed id is a friendly 'nothing to undo', not a 500
  return withTransaction(async (client) => {
    const found = await client.query<any>(`SELECT * FROM finds WHERE id = $1 AND status = 'found' FOR UPDATE`, [input.findId]);
    const find = found.rows[0];
    if (!find) return null;
    const results: FindResult[] = Array.isArray(find.results) ? find.results : [];
    if (results.length === 0) return null; // an empty find has nothing to undo (the admin page says so)
    const names = new Map<string, string>();
    if (results.length) {
      const named = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM content_definitions WHERE id = ANY($1::uuid[])', [results.map((line) => line.item_id)]
      );
      for (const row of named.rows) names.set(row.id, row.name);
    }

    const notes: string[] = [];
    for (const line of results) {
      const name = names.get(line.item_id) ?? 'Unknown item';
      const row = await client.query<{ id: string; quantity: number; source_content_id: string | null }>(
        'SELECT id, quantity, source_content_id FROM character_inventory_items WHERE id = $1 AND character_id = $2 FOR UPDATE',
        [line.inventory_id, find.character_id]
      );
      const current = row.rows[0];
      if (!current) {
        notes.push(`${name}: already removed by the player`);
      } else if (current.source_content_id !== line.item_id) {
        notes.push(`${name}: the row now holds a different item, left alone`);
      } else if (current.quantity > line.qty) {
        await client.query('UPDATE character_inventory_items SET quantity = quantity - $2 WHERE id = $1', [current.id, line.qty]);
        notes.push(`${name}: reduced ${current.quantity} -> ${current.quantity - line.qty}`);
      } else {
        await client.query('DELETE FROM character_inventory_items WHERE id = $1', [current.id]);
        notes.push(current.quantity < line.qty
          ? `${name}: removed (${current.quantity} left of ${line.qty} found)`
          : `${name}: removed`);
      }
    }
    const note = notes.join('; ');
    await client.query(
      `UPDATE finds SET status = 'reverted', reverted_at = now(), reverted_by_user_id = $2, revert_note = $3 WHERE id = $1`,
      [find.id, input.adminUserId, note]
    );
    return {
      note, characterId: find.character_id, finderUserId: find.finder_user_id, roomCode: find.room_code,
      gameSessionId: find.game_session_id
    };
  });
}

/** Every unmarked self-serve check, newest first, so an admin can find a stuck one to clear. */
export async function listUnmarkedChecks(): Promise<Array<UnmarkedSelfFind & { finderUserId: string; createdAt: string }>> {
  const result = await query(
    `SELECT id, character_id, find_table_id, check_json, room_code, finder_user_id, created_at
     FROM finds WHERE status = 'checked' ORDER BY created_at DESC LIMIT 100`
  );
  return result.rows.map((row) => ({ ...mapUnmarked(row), finderUserId: row.finder_user_id, createdAt: row.created_at }));
}

/**
 * Admin: closes a stuck unmarked check as a failed find (nothing is added), so the player can
 * forage again. The row is kept, with a note, never deleted.
 */
export async function clearUnmarkedCheck(findId: string): Promise<{ gameSessionId: string | null } | null> {
  if (!UUID_PATTERN.test(findId)) return null;
  const result = await query(
    `UPDATE finds SET status = 'failed', resolved_at = now(), revert_note = 'Unmarked check cleared by an admin.'
     WHERE id = $1 AND status = 'checked' RETURNING game_session_id`, [findId]
  );
  // The game session id lets the caller nudge open Session Notes views.
  return result.rows[0] ? { gameSessionId: result.rows[0].game_session_id } : null;
}

/**
 * Suggested checks for one campaign's active tables, in one query, keyed by table id. DM-side only
 * (Q9): the tables endpoint calls this only for the GM of a live room, with that room's campaign.
 */
export async function listSuggestedChecks(campaignId: string): Promise<Map<string, string>> {
  const result = await query<{ id: string; suggested_check: string }>(
    'SELECT id, suggested_check FROM find_tables WHERE is_archived = false AND campaign_id = $1', [campaignId]
  );
  return new Map(result.rows.map((row) => [row.id, row.suggested_check]));
}

// ---------------------------------------------------------------------------------------------
// Share, session summary and admin review (unit D)
// ---------------------------------------------------------------------------------------------

/** Live item names for some ids (content rows are never hard-deleted, so a miss means a bad id). */
async function itemNamesFor(runner: { query: (sql: string, params: any[]) => Promise<{ rows: any[] }> }, itemIds: string[]): Promise<Map<string, string>> {
  if (!itemIds.length) return new Map();
  const named = await runner.query('SELECT id, name FROM content_definitions WHERE id = ANY($1::uuid[])', [itemIds]);
  return new Map(named.rows.map((row: { id: string; name: string }) => [row.id, row.name]));
}

function namedLines(results: FindResult[], names: Map<string, string>): Array<{ name: string; qty: number }> {
  return results.map((line) => ({ name: names.get(line.item_id) ?? 'Unknown item', qty: line.qty }));
}

export type SharedFind = {
  findId: string; finderUserId: string; characterId: string; characterName: string;
  roomCode: string | null; gameSessionId: string | null; lines: Array<{ name: string; qty: number }>;
};

export type ShareOutcome =
  | { ok: false; error: 'not_found' | 'forbidden' | 'not_shareable' }
  | { ok: true; alreadyShared: true }
  | { ok: true; alreadyShared: false; find: SharedFind };

/**
 * The finder (or the character's owner) shares a standing find with the party. One way: nothing
 * un-shares it. Only 'found' finds can be shared (failed and reverted ones have nothing to show).
 * The row is locked so two quick taps can only share once; the second gets alreadyShared and the
 * caller posts no second log line. This is the ONLY place item names become public.
 */
export async function shareFind(findId: string, userId: string): Promise<ShareOutcome> {
  if (!UUID_PATTERN.test(findId)) return { ok: false, error: 'not_found' };
  return withTransaction(async (client): Promise<ShareOutcome> => {
    const found = await client.query<any>(
      `SELECT f.*, c.name AS character_name, c.owner_user_id AS character_owner_id
       FROM finds f JOIN characters c ON c.id = f.character_id WHERE f.id = $1 FOR UPDATE OF f`, [findId]
    );
    const find = found.rows[0];
    if (!find) return { ok: false, error: 'not_found' };
    if (find.finder_user_id !== userId && find.character_owner_id !== userId) return { ok: false, error: 'forbidden' };
    if (find.status !== 'found') return { ok: false, error: 'not_shareable' };
    if (find.shared) return { ok: true, alreadyShared: true };
    const results: FindResult[] = Array.isArray(find.results) ? find.results : [];
    if (results.length === 0) return { ok: false, error: 'not_shareable' }; // an empty find has nothing to show
    await client.query('UPDATE finds SET shared = true WHERE id = $1', [findId]);
    const names = await itemNamesFor(client, results.map((line) => line.item_id));
    return {
      ok: true, alreadyShared: false,
      find: {
        findId, finderUserId: find.finder_user_id, characterId: find.character_id, characterName: find.character_name,
        roomCode: find.room_code, gameSessionId: find.game_session_id, lines: namedLines(results, names)
      }
    };
  });
}

/** One row of a player's own "Recent finds" list. Deliberately carries NO table name, id or suggested check (Rev 4). */
export type RecentFind = {
  id: string; createdAt: string; status: 'found' | 'reverted'; mode: FindMode; shared: boolean;
  items: Array<{ name: string; qty: number }>; revertNote: string;
};

export const RECENT_FINDS_LIMIT = 10;

/**
 * A character's last few standing or undone finds, newest first, so the owner can share a find after
 * its result card is gone (a self-serve find made outside any game session had no other way).
 * Failed and unmarked checks, and found finds with no items, are left out: they have nothing to show or share (and empty ones would push real hauls out of the window). The caller must have
 * owner-checked the character. The query never touches find_tables, so a table can't leak.
 */
export async function listRecentFindsForCharacter(characterId: string, limit = RECENT_FINDS_LIMIT): Promise<RecentFind[]> {
  if (!UUID_PATTERN.test(characterId)) return [];
  const rows = await query<{ id: string; created_at: string; status: 'found' | 'reverted'; mode: FindMode; shared: boolean; results: FindResult[] | null; revert_note: string }>(
    `SELECT id, created_at, status, mode, shared, results, revert_note FROM finds
     WHERE character_id = $1 AND status IN ('found', 'reverted')
       AND NOT (status = 'found' AND results = '[]'::jsonb) ORDER BY created_at DESC LIMIT $2`,
    [characterId, Math.max(1, Math.min(limit, 50))]
  );
  const ids = new Set<string>();
  for (const row of rows.rows) for (const line of Array.isArray(row.results) ? row.results : []) ids.add(line.item_id);
  const names = await itemNamesFor({ query: (sql, params) => query(sql, params) }, [...ids]);
  return rows.rows.map((row) => ({
    id: row.id, createdAt: row.created_at, status: row.status, mode: row.mode, shared: row.shared,
    items: namedLines(Array.isArray(row.results) ? row.results : [], names), revertNote: row.revert_note
  }));
}

type FindListRow = {
  id: string; created_at: string; status: FindStatus; mode: FindMode; shared: boolean; results: FindResult[] | null;
  check_json: ForageCheck | null; revert_note: string; finder_user_id: string; character_id: string;
  character_name: string; character_owner_id: string; owner_name: string | null; table_name: string;
  game_session_id: string | null; game_session_name: string | null; room_code: string | null; nat20: boolean;
  campaign_name: string | null;
};

const FIND_LIST_SELECT = `
  SELECT f.id, f.created_at, f.status, f.mode, f.shared, f.results, f.check_json, f.revert_note, f.finder_user_id,
         f.character_id, f.game_session_id, f.room_code, f.nat20,
         c.name AS character_name, c.owner_user_id AS character_owner_id, u.display_name AS owner_name, cp.name AS campaign_name,
         -- A self-serve find of an area + category with no table names what was searched for instead.
         COALESCE(t.name, 'No table (' || f.area_type || ', ' || f.category || ')') AS table_name, g.name AS game_session_name
  FROM finds f
  JOIN characters c ON c.id = f.character_id
  JOIN users u ON u.id = f.finder_user_id
  LEFT JOIN find_tables t ON t.id = f.find_table_id
  LEFT JOIN game_sessions g ON g.id = f.game_session_id
  LEFT JOIN campaigns cp ON cp.id = f.campaign_id`;

const resultsOf = (row: FindListRow): FindResult[] => (Array.isArray(row.results) ? row.results : []);

/** Loads live names for every result line of a set of find rows in one query. */
async function namesForRows(rows: FindListRow[]): Promise<Map<string, string>> {
  const ids = new Set<string>();
  for (const row of rows) for (const line of resultsOf(row)) ids.add(line.item_id);
  return itemNamesFor({ query: (sql, params) => query(sql, params) }, [...ids]);
}

function toViewerFind(row: FindListRow, names: Map<string, string>): FindForViewer {
  return {
    id: row.id, createdAt: row.created_at, status: row.status, mode: row.mode, shared: row.shared,
    characterName: row.character_name, finderUserId: row.finder_user_id, characterOwnerId: row.character_owner_id,
    check: row.check_json, tableName: row.table_name, revertNote: row.revert_note,
    items: namedLines(resultsOf(row), names)
  };
}

/**
 * The Finds section of Session Notes, shaped per viewer by the server so a redacted row never
 * carries a name. "The DM" is the Game Session owner (Q3), an admin, or a real DM (primary or co-DM)
 * of the session's campaign. Unmarked checks are never listed. Finds made with no Game Session running aren't
 * here at all (they only show in the admin review). Null if the game session doesn't exist.
 */
export async function listFindsForGameSession(gameSessionId: string, viewer: { id: string; role: string }): Promise<{
  isDm: boolean; finds: SessionFindView[];
} | null> {
  if (!UUID_PATTERN.test(gameSessionId)) return null;
  const owner = await query<{ owner_user_id: string; campaign_id: string | null }>('SELECT owner_user_id, campaign_id FROM game_sessions WHERE id = $1', [gameSessionId]);
  if (!owner.rowCount) return null;
  const sessionCampaignId = owner.rows[0].campaign_id;
  const isDm = owner.rows[0].owner_user_id === viewer.id || viewer.role === 'admin'
    || (!!sessionCampaignId && await isCampaignDm({ query: (text, params) => query(text, params) }, viewer.id, sessionCampaignId));
  const rows = await query<FindListRow>(
    `${FIND_LIST_SELECT} WHERE f.game_session_id = $1 AND f.status <> 'checked' ORDER BY f.created_at DESC LIMIT 200`, [gameSessionId]
  );
  const names = await namesForRows(rows.rows);
  return { isDm, finds: rows.rows.map((row) => shapeFindForViewer(toViewerFind(row, names), { id: viewer.id, isDm })) };
}

/** campaignId is a campaign uuid, or 'none' for the older finds made before campaigns existed. */
export type AdminFindFilter = { gameSessionId?: string; characterId?: string; status?: string; campaignId?: string };

export type AdminFindRow = {
  id: string; createdAt: string; status: FindStatus; mode: FindMode; shared: boolean; characterId: string;
  characterName: string; ownerName: string; tableName: string; checkSummary: string; nat20: boolean;
  gameSessionId: string | null; gameSessionName: string | null; roomCode: string | null; revertNote: string;
  /** The campaign the forage ran in; null for finds made before campaigns existed. */
  campaignName: string | null;
  items: Array<{ name: string; qty: number; inventoryId: string; row: { name: string; quantity: number } | null }>;
};

export const ADMIN_FIND_STATUSES = ['all', 'dm', 'self', 'checked', 'failed', 'found', 'reverted'] as const;

/**
 * Admin review: newest first, capped at 200. status takes a real status or a mode ('dm' / 'self').
 * Each item line also shows the inventory row it wrote to as it is NOW (null if it's gone), so the
 * admin can see what an undo would do.
 */
export async function listFindsForAdmin(filter: AdminFindFilter): Promise<AdminFindRow[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.gameSessionId && UUID_PATTERN.test(filter.gameSessionId)) { params.push(filter.gameSessionId); where.push(`f.game_session_id = $${params.length}`); }
  if (filter.characterId && UUID_PATTERN.test(filter.characterId)) { params.push(filter.characterId); where.push(`f.character_id = $${params.length}`); }
  if (filter.campaignId === 'none') where.push('f.campaign_id IS NULL');
  else if (filter.campaignId && UUID_PATTERN.test(filter.campaignId)) { params.push(filter.campaignId); where.push(`f.campaign_id = $${params.length}`); }
  if (filter.status === 'dm' || filter.status === 'self') { params.push(filter.status); where.push(`f.mode = $${params.length}`); }
  else if (filter.status && ['checked', 'failed', 'found', 'reverted'].includes(filter.status)) { params.push(filter.status); where.push(`f.status = $${params.length}`); }
  const rows = await query<FindListRow>(
    `${FIND_LIST_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY f.created_at DESC LIMIT 200`, params
  );
  const names = await namesForRows(rows.rows);
  const inventoryIds = rows.rows.flatMap((row) => resultsOf(row).map((line) => line.inventory_id)).filter((id) => UUID_PATTERN.test(id ?? ''));
  const current = new Map<string, { name: string; quantity: number }>();
  if (inventoryIds.length) {
    const inv = await query<{ id: string; name: string; quantity: number }>(
      'SELECT id, name, quantity FROM character_inventory_items WHERE id = ANY($1::uuid[])', [inventoryIds]
    );
    for (const row of inv.rows) current.set(row.id, { name: row.name, quantity: row.quantity });
  }
  return rows.rows.map((row) => ({
    id: row.id, createdAt: row.created_at, status: row.status, mode: row.mode, shared: row.shared, characterId: row.character_id,
    characterName: row.character_name, ownerName: row.owner_name ?? 'Unknown', tableName: row.table_name,
    checkSummary: findCheckSummary(row.check_json), nat20: row.nat20, gameSessionId: row.game_session_id,
    gameSessionName: row.game_session_name, roomCode: row.room_code, revertNote: row.revert_note, campaignName: row.campaign_name,
    items: resultsOf(row).map((line) => ({
      name: names.get(line.item_id) ?? 'Unknown item', qty: line.qty, inventoryId: line.inventory_id, row: current.get(line.inventory_id) ?? null
    }))
  }));
}

/** The dropdown options for the admin filters: only sessions and characters that have finds. */
export async function listFindFilterOptions(): Promise<{
  sessions: Array<{ id: string; name: string; createdAt: string }>; characters: Array<{ id: string; name: string }>;
  campaigns: Array<{ id: string; name: string }>;
}> {
  const [sessionRows, characterRows, campaignRows] = await Promise.all([
    query<{ id: string; name: string; created_at: string }>(
      `SELECT g.id, g.name, g.created_at FROM game_sessions g WHERE EXISTS (SELECT 1 FROM finds f WHERE f.game_session_id = g.id)
       ORDER BY g.created_at DESC LIMIT 100`),
    query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM characters c WHERE EXISTS (SELECT 1 FROM finds f WHERE f.character_id = c.id) ORDER BY c.name LIMIT 200`),
    query<{ id: string; name: string }>(
      `SELECT cp.id, cp.name FROM campaigns cp WHERE EXISTS (SELECT 1 FROM finds f WHERE f.campaign_id = cp.id) ORDER BY lower(cp.name) LIMIT 100`)
  ]);
  return {
    sessions: sessionRows.rows.map((row) => ({ id: row.id, name: row.name, createdAt: row.created_at })),
    characters: characterRows.rows,
    campaigns: campaignRows.rows
  };
}
