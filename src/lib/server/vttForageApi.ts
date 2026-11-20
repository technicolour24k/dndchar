import { query } from '$lib/server/db';
import { normaliseTag, resolveTable } from '$lib/rules/forage';
import { FORAGE_SELF_SKILLS, findSkill } from '$lib/rules/skills';
import { parseAttackOptions } from '$lib/server/vttAttackAdvantage';
import { getActiveTable, loadForageCatalogue } from '$lib/server/services/forage';
import type { ForageChoice } from '$lib/server/vttForage';

// Small helpers shared by the forage HTTP endpoints.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

/** A string of at most `max` characters, else ''. Keeps request bodies bounded. */
export function shortText(value: unknown, max = 200): string {
  return typeof value === 'string' && value.length <= max ? value : '';
}

/**
 * The character (owner-scoped) with its owner's active room, in one query. Null if the character
 * isn't the user's. Every player-facing action starts here.
 */
export async function loadOwnedCharacter(userId: string, characterId: unknown): Promise<{ name: string; activeRoomId: string | null } | null> {
  if (!isUuid(characterId)) return null;
  const result = await query<{ name: string; active_vtt_session_id: string | null }>(
    `SELECT c.name, u.active_vtt_session_id FROM characters c JOIN users u ON u.id = c.owner_user_id
     WHERE c.id = $1 AND c.owner_user_id = $2`,
    [characterId, userId]
  );
  const row = result.rows[0];
  return row ? { name: row.name, activeRoomId: row.active_vtt_session_id } : null;
}

/**
 * Validates the picks from a request body. The skill must be one of the 18, and the table must be
 * an active one with something pickable (a table with nothing to roll can't be foraged).
 */
export async function parseChoice(body: any): Promise<{ choice: ForageChoice; tableName: string } | { error: 'bad_skill' | 'bad_table' | 'table_empty' }> {
  const skillKey = shortText(body?.skillKey, 40);
  if (!findSkill(skillKey)) return { error: 'bad_skill' };
  const table = await getActiveTable(shortText(body?.tableId, 40));
  if (!table) return { error: 'bad_table' };
  if (table.pickableCount === 0) return { error: 'table_empty' };
  const options = parseAttackOptions(body);
  return {
    tableName: table.name,
    choice: {
      skillKey,
      // Free text for display and for pre-filling the DM's popup. The table itself is the tableId.
      areaType: normaliseTag(shortText(body?.areaType, 80)),
      category: normaliseTag(shortText(body?.category, 80)),
      tableId: table.id,
      advantage: {
        disabled: options.disabledSourceIds,
        situationalAdvantage: options.situationalAdvantage,
        situationalDisadvantage: options.situationalDisadvantage
      }
    }
  };
}

/** An unmarked self check as a player may see it: the check itself, never which table it is on. */
export function playerUnmarked<T extends { tableId?: unknown } | null>(find: T): Omit<NonNullable<T>, 'tableId'> | null {
  if (!find) return null;
  const { tableId: _hidden, ...rest } = find as NonNullable<T> & { tableId?: unknown };
  return rest;
}

/** Just the adv/dis counters and unticked sources from a body (the only thing a DM-mode player sends). */
export function parseAdvantage(body: any): ForageChoice['advantage'] {
  const options = parseAttackOptions(body);
  return {
    disabled: options.disabledSourceIds,
    situationalAdvantage: options.situationalAdvantage,
    situationalDisadvantage: options.situationalDisadvantage
  };
}

/**
 * A SELF-SERVE player's picks. The skill must be on the short list, and the table is resolved HERE
 * from area + category: the player never names a table (a tableId in the body is ignored). Any area
 * + category is accepted, with or without a table behind it: one with no pickable table gets a null
 * tableId, rolls and marks exactly like any other, and a pass just finds nothing. So a player can't
 * tell from the popup which combinations have a table.
 */
export async function parseSelfChoice(body: any): Promise<
  { choice: Omit<ForageChoice, 'tableId'> & { tableId: string | null } } | { error: 'skill_not_allowed' | 'bad_pick' }
> {
  const skillKey = shortText(body?.skillKey, 40);
  if (!FORAGE_SELF_SKILLS.includes(skillKey)) return { error: 'skill_not_allowed' };
  const areaType = normaliseTag(shortText(body?.areaType, 80));
  const category = normaliseTag(shortText(body?.category, 80));
  if (!areaType || !category) return { error: 'bad_pick' };
  const table = resolveTable(await loadForageCatalogue(), areaType, category);
  const tableId = table && table.pickableCount > 0 ? table.id : null;
  return { choice: { skillKey, areaType, category, tableId, advantage: parseAdvantage(body) } };
}

/** The `advantage` part of a stored choice, shaped as a request body for parseAttackOptions. */
export function advantageBody(choice: ForageChoice): { advantage: ForageChoice['advantage'] } {
  return { advantage: choice.advantage };
}
