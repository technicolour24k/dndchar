import { query, withTransaction } from '$lib/server/db';
import { cachedReference, invalidateReferenceData } from '$lib/server/cache/referenceData';
import { parseEntryInput, parseTableInput } from '$lib/rules/forage';
import type { FindTable, FindTableEntry, ForageCatalogue } from '$lib/types/forage';

// Find tables (forage / loot finder, unit A). A table only points at existing item Containers and
// grants no mechanics, so any logged-in user may author one (Q2). Editing is owner-or-admin, and
// every table is usable by everyone. When the campaign system lands, tables should gain a
// campaign_id and campaign-DM scoping instead of being global to the whole group.

/** The bits of the signed-in user the permission check needs. */
export type ForageActor = { id: string; role: 'user' | 'admin' };

type TableRow = {
  id: string; name: string; area_type: string; category: string; type_die: number; suggested_check: string;
  is_archived: boolean; owner_user_id: string | null; owner_name: string | null;
  entry_count: number; pickable_count: number;
};

type EntryRow = {
  find_table_id: string; item_id: string; item_name: string; item_category: string | null;
  weight: number; qty_die: number; sort_order: number; item_archived: boolean;
};

function mapTable(row: TableRow): FindTable {
  return {
    id: row.id, name: row.name, areaType: row.area_type, category: row.category, typeDie: row.type_die,
    suggestedCheck: row.suggested_check, isArchived: row.is_archived, ownerUserId: row.owner_user_id,
    ownerName: row.owner_name, entryCount: row.entry_count, pickableCount: row.pickable_count
  };
}

function mapEntry(row: EntryRow): FindTableEntry {
  return {
    itemId: row.item_id, itemName: row.item_name, itemCategory: row.item_category ?? 'gear', weight: row.weight,
    qtyDie: row.qty_die, itemArchived: row.item_archived, sortOrder: row.sort_order
  };
}

const ENTRY_SELECT = `
  SELECT e.find_table_id, e.item_id, c.name AS item_name, i.category AS item_category, e.weight, e.qty_die,
         e.sort_order, c.is_archived AS item_archived
  FROM find_table_entries e
  JOIN content_definitions c ON c.id = e.item_id
  LEFT JOIN item_definitions i ON i.content_id = c.id`;

/** Every table (archived included) with counts, for the authoring page. */
export async function listFindTables(): Promise<FindTable[]> {
  const result = await query<TableRow>(`
    SELECT t.id, t.name, t.area_type, t.category, t.type_die, t.suggested_check, t.is_archived,
           t.owner_user_id, u.display_name AS owner_name,
           COUNT(e.item_id)::int AS entry_count,
           COUNT(e.item_id) FILTER (WHERE e.weight > 0 AND NOT c.is_archived)::int AS pickable_count
    FROM find_tables t
    LEFT JOIN users u ON u.id = t.owner_user_id
    LEFT JOIN find_table_entries e ON e.find_table_id = t.id
    LEFT JOIN content_definitions c ON c.id = e.item_id
    GROUP BY t.id, u.display_name
    ORDER BY t.area_type, t.category, t.name`);
  return result.rows.map(mapTable);
}

export async function getFindTableEntries(tableId: string): Promise<FindTableEntry[]> {
  const result = await query<EntryRow>(`${ENTRY_SELECT} WHERE e.find_table_id = $1 ORDER BY e.sort_order, c.name`, [tableId]);
  return result.rows.map(mapEntry);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The service's own permission gate: owner or admin. Throws a user-facing Error.
// A malformed id is "not found" rather than Postgres's raw 22P02 text.
async function requireEditableTable(actor: ForageActor, tableId: string): Promise<void> {
  if (!UUID_PATTERN.test(tableId)) throw new Error('Find table not found.');
  const result = await query<{ owner_user_id: string | null }>('SELECT owner_user_id FROM find_tables WHERE id = $1', [tableId]);
  if (!result.rowCount) throw new Error('Find table not found.');
  const owner = result.rows[0].owner_user_id;
  if (actor.role !== 'admin' && owner !== actor.id) throw new Error('You can only edit find tables you created.');
}

export function canEditFindTable(actor: ForageActor, table: Pick<FindTable, 'ownerUserId'>): boolean {
  return actor.role === 'admin' || table.ownerUserId === actor.id;
}

/**
 * Adds canEdit to each table and blanks suggestedCheck for anyone who can't edit it (Q9: only the
 * owner and admins see that DM-side reminder in authoring).
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

// 23505 on the one-active-table-per-area+category index becomes a friendly message.
function friendlyTableError(error: unknown, areaType: string, category: string): Error {
  if ((error as { code?: string })?.code === '23505') {
    return new Error(`There's already an active table for ${areaType} + ${category}.`);
  }
  return error instanceof Error ? error : new Error('Could not save the find table.');
}

export async function createFindTable(actor: ForageActor, form: FormData): Promise<string> {
  const input = parseTableInput({
    name: form.get('name'), areaType: form.get('areaType'), category: form.get('category'),
    typeDie: form.get('typeDie'), suggestedCheck: form.get('suggestedCheck')
  });
  try {
    const result = await query<{ id: string }>(
      `INSERT INTO find_tables (name, area_type, category, type_die, suggested_check, owner_user_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.name, input.areaType, input.category, input.typeDie, input.suggestedCheck, actor.id]
    );
    invalidateReferenceData('forage:create-table');
    return result.rows[0].id;
  } catch (error) {
    throw friendlyTableError(error, input.areaType, input.category);
  }
}

export async function updateFindTable(actor: ForageActor, form: FormData): Promise<string> {
  const tableId = String(form.get('tableId') || '');
  await requireEditableTable(actor, tableId);
  const input = parseTableInput({
    name: form.get('name'), areaType: form.get('areaType'), category: form.get('category'),
    typeDie: form.get('typeDie'), suggestedCheck: form.get('suggestedCheck')
  });
  try {
    await query(
      `UPDATE find_tables SET name = $2, area_type = $3, category = $4, type_die = $5, suggested_check = $6,
         updated_at = now() WHERE id = $1`,
      [tableId, input.name, input.areaType, input.category, input.typeDie, input.suggestedCheck]
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
  const { weight, qtyDie } = parseEntryInput({ weight: form.get('weight') || 1, qtyDie: form.get('qtyDie') || 1 });

  // Postgres can't CHECK across tables, so the "is an item Container" rule lives here.
  if (!UUID_PATTERN.test(itemId)) throw new Error('That is not an item.');
  const item = await query<{ is_archived: boolean }>(
    "SELECT is_archived FROM content_definitions WHERE id = $1 AND content_type = 'item'", [itemId]
  );
  if (!item.rowCount) throw new Error('That is not an item.');
  if (item.rows[0].is_archived) throw new Error('That item is archived and cannot be added.');

  // Never overwrite a tuned entry: a repeat add is refused (edit it in the entries list instead).
  const added = await query(
    `INSERT INTO find_table_entries (find_table_id, item_id, weight, qty_die, sort_order)
     VALUES ($1, $2, $3, $4, COALESCE((SELECT MAX(sort_order) + 1 FROM find_table_entries WHERE find_table_id = $1), 0))
     ON CONFLICT (find_table_id, item_id) DO NOTHING`,
    [tableId, itemId, weight, qtyDie]
  );
  if (!added.rowCount) throw new Error('That item is already on this table.');
  await query('UPDATE find_tables SET updated_at = now() WHERE id = $1', [tableId]);
  invalidateReferenceData('forage:add-entry');
  return tableId;
}

/** Saves weight and qty die for every entry on the page in one go (fields entryItem/weight/qtyDie, repeated). */
export async function updateFindTableEntries(actor: ForageActor, form: FormData): Promise<string> {
  const tableId = String(form.get('tableId') || '');
  await requireEditableTable(actor, tableId);
  const itemIds = form.getAll('entryItem').map(String);
  const weights = form.getAll('weight');
  const qtyDice = form.getAll('qtyDie');
  // Validate everything before writing anything.
  if (!itemIds.every((id) => UUID_PATTERN.test(id))) throw new Error('Item not found.');
  const parsed = itemIds.map((itemId, index) => ({ itemId, ...parseEntryInput({ weight: weights[index], qtyDie: qtyDice[index] }) }));
  await withTransaction(async (client) => {
    for (const entry of parsed) {
      await client.query(
        'UPDATE find_table_entries SET weight = $3, qty_die = $4 WHERE find_table_id = $1 AND item_id = $2',
        [tableId, entry.itemId, entry.weight, entry.qtyDie]
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
      SELECT t.id, t.name, t.area_type, t.category, t.type_die, '' AS suggested_check, t.is_archived,
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
        const { ownerName: _ownerName, entryCount: _entryCount, suggestedCheck: _suggestedCheck, ...table } = mapTable(row);
        return { ...table, entries: list, pickableCount: list.filter((entry) => entry.weight > 0 && !entry.itemArchived).length };
      })
    };
  });
}
