import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { cachedReference, invalidateReferenceData } from '$lib/server/cache/referenceData';
import { assertCanEditCharacter, getCampaignAccess, isUuid, type Queryable } from '$lib/server/services/access';
import { CampaignError } from '$lib/server/campaignError';
import { resolveCharacterModifierSources } from '$lib/server/services/rule-engine';
import { abilityMap, abilityModifier, totalLevel } from '$lib/rules/dnd5e';
import { effectiveProficiencyBonus, readStatOverrides } from '$lib/rules/characterStats';
import { ledgerBadge, poolMaxima, undoMessage, type PoolMaxContext, type PoolMaximum } from '$lib/rules/cost';
import type { ActiveCharacterEffect, CharacterAbility, CharacterClass, CharacterPool } from '$lib/types/character';

// Character resource pools (Soulfire, Vowfire, any DM-defined pool). Definitions are global and
// DM-authored. Per-character state lives in character_resources under the key 'pool:<key>'.
// Rows are lazy: NO ROW MEANS FULL (current = live max). The stored max_value is only a cache;
// the live max is always recomputed from the definition plus resource.<key>.max modifiers.

export type PoolDefinition = {
  key: string;
  label: string;
  description: string;
  baseMaxExpression: string;
  rechargePeriod: 'short_rest' | 'long_rest' | 'dawn' | 'encounter' | 'manual';
  showWhenEmpty: boolean;
  sortOrder: number;
  isArchived: boolean;
  isSystem: boolean;
};

export const POOL_RECHARGE_PERIODS = ['short_rest', 'long_rest', 'dawn', 'encounter', 'manual'] as const;
export const RESERVED_POOL_KEYS = ['spell_slot', 'charges', 'item', 'action', 'bonus_action', 'reaction', 'hp', 'temp_hp', 'inspiration'];
const KEY_PATTERN = /^[a-z][a-z0-9_]{1,39}$/;
export const POOL_ROW_PREFIX = 'pool:';
const rowKey = (key: string) => `${POOL_ROW_PREFIX}${key}`;

type DefinitionRow = {
  pool_key: string; label: string; description: string; base_max_expression: string; recharge_period: PoolDefinition['rechargePeriod'];
  show_when_empty: boolean; sort_order: number; is_archived: boolean; is_system: boolean;
};

function mapDefinition(row: DefinitionRow): PoolDefinition {
  return {
    key: row.pool_key, label: row.label, description: row.description, baseMaxExpression: row.base_max_expression,
    rechargePeriod: row.recharge_period, showWhenEmpty: row.show_when_empty, sortOrder: row.sort_order,
    isArchived: row.is_archived, isSystem: row.is_system
  };
}

export async function loadDefinitions(db: Queryable, includeArchived: boolean): Promise<PoolDefinition[]> {
  const result = await db.query(
    `SELECT * FROM resource_pool_definitions ${includeArchived ? '' : 'WHERE NOT is_archived'} ORDER BY sort_order, label`
  );
  return result.rows.map(mapDefinition);
}

// Shared reference data: cached, and cleared by the admin writes below.
export async function listPoolDefinitions(options: { includeArchived?: boolean } = {}): Promise<PoolDefinition[]> {
  const includeArchived = Boolean(options.includeArchived);
  return structuredClone(await cachedReference(`pool-definitions:${includeArchived}`, () => loadDefinitions({ query }, includeArchived)));
}

// The context resolveResourceMaximum needs, built the same way content counters build theirs.
export function poolContextFor(classes: CharacterClass[], abilities: CharacterAbility[], metadata: Record<string, unknown> | null | undefined): PoolMaxContext {
  const level = totalLevel(classes);
  const mods = Object.values(abilityMap(abilities)).map(abilityModifier);
  return {
    level,
    proficiencyBonus: effectiveProficiencyBonus(level, readStatOverrides(metadata ?? {})),
    abilityModifier: mods.length ? Math.max(...mods) : 0
  };
}

type PoolRow = { resource_key: string; current_value: number };

// The sheet's pools. A pool shows when its max is above 0, it still holds something, or its
// definition says to show it empty. Archived pools only show while they still hold something.
export async function getCharacterPools(
  db: Queryable,
  characterId: string,
  definitions: PoolDefinition[],
  modifierSources: ActiveCharacterEffect[],
  ctx: PoolMaxContext
): Promise<CharacterPool[]> {
  const maxima = poolMaxima(definitions.map((d) => ({ key: d.key, baseMaxExpression: d.baseMaxExpression })), modifierSources, ctx);
  const rows = await db.query(`SELECT resource_key, current_value FROM character_resources WHERE character_id = $1 AND resource_key LIKE 'pool:%'`, [characterId]);
  const stored = new Map<string, number>((rows.rows as PoolRow[]).map((row) => [row.resource_key.slice(POOL_ROW_PREFIX.length), row.current_value]));
  const pools: CharacterPool[] = [];
  for (const definition of definitions) {
    const { max, lines } = maxima[definition.key];
    const current = stored.has(definition.key) ? Math.max(0, Math.min(max, stored.get(definition.key)!)) : max;
    const held = stored.has(definition.key) ? stored.get(definition.key)! > 0 : false;
    if (definition.isArchived ? !held : !(max > 0 || current > 0 || definition.showWhenEmpty)) continue;
    pools.push({ key: definition.key, label: definition.label, current, max, rechargePeriod: definition.rechargePeriod, breakdown: lines });
  }
  return pools;
}

// Live maxima for every non-archived pool (every pool with includeArchived), loading what it needs.
// Call OUTSIDE a transaction.
// With `db` (a transaction client) it reads sequentially on that client and never takes another
// pool connection.
export async function loadPoolMaxima(characterId: string, includeArchived = false, db?: Queryable): Promise<{ definitions: PoolDefinition[]; maxima: Record<string, PoolMaximum> }> {
  const q = db ?? { query };
  const definitions = db ? await loadDefinitions(db, includeArchived) : await listPoolDefinitions({ includeArchived });
  const sources = await resolveCharacterModifierSources(characterId, q);
  const classes = await q.query('SELECT class_name, level FROM character_classes WHERE character_id = $1', [characterId]);
  const abilities = await q.query('SELECT ability_key, score FROM character_abilities WHERE character_id = $1', [characterId]);
  const character = await q.query('SELECT metadata_json FROM characters WHERE id = $1', [characterId]);
  const ctx = poolContextFor(
    classes.rows.map((row: { class_name: string; level: number }) => ({ className: row.class_name, level: row.level }) as CharacterClass),
    abilities.rows.map((row: { ability_key: CharacterAbility['key']; score: number }) => ({ key: row.ability_key, score: row.score })),
    character.rows[0]?.metadata_json
  );
  return { definitions, maxima: poolMaxima(definitions.map((d) => ({ key: d.key, baseMaxExpression: d.baseMaxExpression })), sources.sources, ctx) };
}

// ---------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------

export type LedgerWrite = {
  characterId: string;
  pool: string;
  poolDetail?: Record<string, unknown>;
  label: string;
  delta: number;
  before: number | null;
  after: number | null;
  shortfall?: number;
  reason: 'cost' | 'manual' | 'rest' | 'refund';
  sourceContentId?: string | null;
  sourceLabel?: string;
  activationId?: string | null;
  actorUserId?: string | null;
  overrideKind?: 'dm_approved' | 'dm_self' | 'self_override' | null;
  approvedByUserId?: string | null;
  approvalRequestId?: string | null;
  roomId?: string | null;
  refundOf?: string | null;
};

export async function writeLedger(db: Queryable, row: LedgerWrite): Promise<string> {
  const result = await db.query(
    `INSERT INTO character_resource_ledger
       (character_id, pool, pool_detail, label, delta, before_value, after_value, shortfall, reason, source_content_id, source_label,
        activation_id, actor_user_id, override_kind, approved_by_user_id, approval_request_id, room_id, refund_of)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING id`,
    [
      row.characterId, row.pool, JSON.stringify(row.poolDetail ?? {}), row.label, row.delta, row.before, row.after, row.shortfall ?? 0, row.reason,
      row.sourceContentId ?? null, row.sourceLabel ?? '', row.activationId ?? null, row.actorUserId ?? null, row.overrideKind ?? null,
      row.approvedByUserId ?? null, row.approvalRequestId ?? null, row.roomId ?? null, row.refundOf ?? null
    ]
  );
  return result.rows[0].id;
}

// ---------------------------------------------------------------------------------------------
// Adjusting and refilling
// ---------------------------------------------------------------------------------------------

// Max INCREASES DO NOT REFILL: raising the live max (a new feat, an equipped ring) leaves an existing
// row where it was until a rest tops it up; a pool with no row yet is full. Intended: "max increases
// don't refill; rests do".
//
// Manual +/-: free bookkeeping for anyone who can edit the sheet, logged as 'manual'. Clamped 0..max.
export async function adjustCharacterPool(userId: string, characterId: string, key: string, delta: number): Promise<void> {
  if (!Number.isInteger(delta) || delta === 0) throw new Error('Pick a whole number to change the pool by.');
  await assertCanEditCharacter({ query }, userId, characterId);
  // Archived pools resolve too, so +/- on one the character still holds works rather than 500ing.
  const { definitions, maxima } = await loadPoolMaxima(characterId, true);
  const definition = definitions.find((d) => d.key === key);
  if (!definition) throw new Error('Unknown resource pool.');
  const max = maxima[key].max;
  await withTransaction(async (client) => {
    await assertCanEditCharacter(client, userId, characterId);
    // Lazy upsert at full, then lock the row so two clicks can't both read the same value.
    await client.query(
      `INSERT INTO character_resources (character_id, resource_key, label, current_value, max_value, sort_order)
       VALUES ($1, $2, $3, $4, $4, 200) ON CONFLICT (character_id, resource_key) DO NOTHING`,
      [characterId, rowKey(key), definition.label, max]
    );
    const locked = await client.query<{ current_value: number }>(
      'SELECT current_value FROM character_resources WHERE character_id = $1 AND resource_key = $2 FOR UPDATE', [characterId, rowKey(key)]
    );
    const before = Math.max(0, Math.min(max, locked.rows[0].current_value));
    const after = Math.max(0, Math.min(max, before + delta));
    await client.query(
      'UPDATE character_resources SET current_value = $3, max_value = $4, label = $5 WHERE character_id = $1 AND resource_key = $2',
      [characterId, rowKey(key), after, max, definition.label]
    );
    if (after !== before) {
      await writeLedger(client, {
        characterId, pool: rowKey(key), label: definition.label, delta: after - before, before, after, reason: 'manual', actorUserId: userId
      });
    }
  });
}

// Refills the non-archived pools whose recharge period is in `periods`. Only pools that have a row
// can be below max (no row = full), so those are all that need touching. `maxima` comes from
// loadPoolMaxima, called before the transaction opened.
export async function refillCharacterPools(
  client: pg.PoolClient,
  characterId: string,
  periods: string[],
  actorUserId: string,
  loaded: { definitions: PoolDefinition[]; maxima: Record<string, PoolMaximum> }
): Promise<void> {
  const due = loaded.definitions.filter((d) => !d.isArchived && periods.includes(d.rechargePeriod));
  if (!due.length) return;
  const rows = await client.query<{ resource_key: string; current_value: number }>(
    `SELECT resource_key, current_value FROM character_resources WHERE character_id = $1 AND resource_key = ANY($2::text[]) FOR UPDATE`,
    [characterId, due.map((d) => rowKey(d.key))]
  );
  const current = new Map(rows.rows.map((row) => [row.resource_key, row.current_value]));
  for (const definition of due) {
    const stored = current.get(rowKey(definition.key));
    if (stored === undefined) continue;
    const max = loaded.maxima[definition.key].max;
    const before = Math.max(0, Math.min(max, stored));
    await client.query(
      'UPDATE character_resources SET current_value = $3, max_value = $3 WHERE character_id = $1 AND resource_key = $2',
      [characterId, rowKey(definition.key), max]
    );
    if (max !== before) {
      await writeLedger(client, {
        characterId, pool: rowKey(definition.key), label: definition.label, delta: max - before, before, after: max, reason: 'rest', actorUserId
      });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------------------------

function readExpression(value: unknown): string {
  const text = String(value ?? '').trim().toLowerCase() || '0';
  if (!/^(\d+|level|proficiency_bonus|ability_modifier)$/.test(text)) {
    throw new Error('Base maximum must be a whole number, level, proficiency_bonus or ability_modifier.');
  }
  return text;
}

function readFields(form: FormData) {
  const label = String(form.get('label') ?? '').trim();
  if (!label) throw new Error('A pool needs a name.');
  const recharge = String(form.get('rechargePeriod') ?? 'long_rest');
  if (!(POOL_RECHARGE_PERIODS as readonly string[]).includes(recharge)) throw new Error('Unknown recharge period.');
  return {
    label,
    description: String(form.get('description') ?? '').trim(),
    baseMaxExpression: readExpression(form.get('baseMaxExpression')),
    recharge,
    showWhenEmpty: form.get('showWhenEmpty') === 'on',
    sortOrder: Math.trunc(Number(form.get('sortOrder')) || 0)
  };
}

export async function createPoolDefinition(form: FormData): Promise<string> {
  const key = String(form.get('key') ?? '').trim().toLowerCase();
  if (!KEY_PATTERN.test(key)) throw new Error('Key must be 2-40 characters: a lowercase letter, then lowercase letters, digits or underscores.');
  if (RESERVED_POOL_KEYS.includes(key)) throw new Error(`"${key}" is reserved.`);
  const f = readFields(form);
  await withTransaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM resource_pool_definitions WHERE pool_key = $1', [key]);
    if (exists.rowCount) throw new Error(`A pool with the key "${key}" already exists.`);
    await client.query(
      `INSERT INTO resource_pool_definitions (pool_key, label, description, base_max_expression, recharge_period, show_when_empty, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [key, f.label, f.description, f.baseMaxExpression, f.recharge, f.showWhenEmpty, f.sortOrder]
    );
    // So a DM can attach "<Label> (max)" to a feat straight away.
    const target = `resource.${key}.max`;
    await client.query(
      `INSERT INTO modifier_targets (target_key, label, category, value_kind, runtime_supported, description, is_system)
       VALUES ($1,$2,'resource','number',true,$3,false) ON CONFLICT (target_key) DO NOTHING`,
      [target, `${f.label} (maximum)`, `Raises the character's maximum ${f.label}. Sources sum by count.`]
    );
    await client.query(
      `INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, label, is_system)
       SELECT $1, 'bonus', '1', $2, false
       WHERE NOT EXISTS (SELECT 1 FROM modifier_definitions WHERE target = $1 AND modifier_type = 'bonus'
         AND COALESCE(default_value_expression,'') = '1' AND NOT is_archived)
       ON CONFLICT DO NOTHING`,
      [target, `${f.label} (max)`]
    );
  });
  invalidateReferenceData('createPoolDefinition');
  return key;
}

// The key never changes: costs and modifier targets reference it.
export async function updatePoolDefinition(key: string, form: FormData): Promise<void> {
  const f = readFields(form);
  const result = await query(
    `UPDATE resource_pool_definitions SET label=$2, description=$3, base_max_expression=$4, recharge_period=$5,
       show_when_empty=$6, sort_order=$7, updated_at=now() WHERE pool_key=$1`,
    [key, f.label, f.description, f.baseMaxExpression, f.recharge, f.showWhenEmpty, f.sortOrder]
  );
  if (!result.rowCount) throw new Error('Pool not found.');
  invalidateReferenceData('updatePoolDefinition');
}

// Archive / unarchive. Never deleted: costs and ledger rows still point at the key.
export async function togglePoolArchived(key: string): Promise<void> {
  const result = await query('UPDATE resource_pool_definitions SET is_archived = NOT is_archived, updated_at = now() WHERE pool_key = $1', [key]);
  if (!result.rowCount) throw new Error('Pool not found.');
  invalidateReferenceData('togglePoolArchived');
}

// ---------------------------------------------------------------------------------------------
// Ledger views and DM review of self overrides (cost engine Unit 7)
// ---------------------------------------------------------------------------------------------

export type LedgerView = {
  id: string; createdAt: string; pool: string; label: string; delta: number; before: number | null; after: number | null; shortfall: number;
  reason: 'cost' | 'manual' | 'rest' | 'refund'; sourceLabel: string; overrideKind: string | null; reviewOutcome: 'ok' | 'undone' | null;
  badge: string | null; actorName: string | null; approvedByName: string | null; activationId: string | null;
};

// The newest ledger rows for one character (the sheet's Activity Log "Resources" tab). The caller
// has already checked the viewer may see the character.
export async function listLedger(characterId: string, limit = 50): Promise<LedgerView[]> {
  const result = await query<any>(
    `SELECT l.*, actor.display_name AS actor_name, approver.display_name AS approver_name
     FROM character_resource_ledger l
     LEFT JOIN users actor ON actor.id = l.actor_user_id
     LEFT JOIN users approver ON approver.id = l.approved_by_user_id
     WHERE l.character_id = $1 ORDER BY l.created_at DESC, l.id DESC LIMIT $2`,
    [characterId, Math.max(1, Math.min(200, limit))]
  );
  return result.rows.map((row: any) => ({
    id: row.id, createdAt: row.created_at, pool: row.pool, label: row.label, delta: row.delta, before: row.before_value, after: row.after_value,
    shortfall: row.shortfall, reason: row.reason, sourceLabel: row.source_label, overrideKind: row.override_kind, reviewOutcome: row.review_outcome,
    badge: ledgerBadge({ overrideKind: row.override_kind, reviewOutcome: row.review_outcome, reason: row.reason }),
    actorName: row.actor_name ?? null, approvedByName: row.approver_name ?? null, activationId: row.activation_id
  }));
}

export type OverrideReview = {
  activationId: string; characterId: string; characterName: string; playerName: string; sourceLabel: string; createdAt: string;
  lines: Array<{ label: string; delta: number; shortfall: number }>; shortText: string;
};

// Unreviewed "the DM OK'd it" overspends for a campaign's characters, one entry per activation.
export async function listUnreviewedOverrides(campaignId: string): Promise<OverrideReview[]> {
  const result = await query<any>(
    `SELECT l.activation_id, l.character_id, l.label, l.delta, l.shortfall, l.source_label, l.created_at, c.name AS character_name, actor.display_name AS actor_name
     FROM character_resource_ledger l
     JOIN characters c ON c.id = l.character_id
     LEFT JOIN users actor ON actor.id = l.actor_user_id
     WHERE c.campaign_id = $1 AND l.override_kind = 'self_override' AND l.reviewed_at IS NULL AND l.activation_id IS NOT NULL
     ORDER BY l.created_at, l.id`,
    [campaignId]
  );
  const byActivation = new Map<string, OverrideReview>();
  for (const row of result.rows) {
    let review = byActivation.get(row.activation_id);
    if (!review) {
      review = {
        activationId: row.activation_id, characterId: row.character_id, characterName: row.character_name, playerName: row.actor_name ?? 'A player',
        sourceLabel: row.source_label, createdAt: row.created_at, lines: [], shortText: ''
      };
      byActivation.set(row.activation_id, review);
    }
    review.lines.push({ label: row.label, delta: row.delta, shortfall: row.shortfall });
  }
  return [...byActivation.values()].map((review) => ({
    ...review,
    shortText: review.lines.filter((line) => line.shortfall > 0).map((line) => `${line.shortfall} ${line.label}`).join(', ')
  }));
}

export type ReviewResult = {
  status: 'ok' | 'undone' | 'already_reviewed' | 'not_found';
  message: string;
  characterId?: string; characterName?: string; sourceLabel?: string; roomId?: string | null; refunded?: string[];
};

// Refund order follows the lock order in cost-engine.ts: slots, content counters, inventory counters, item, pools.
const refundRank = (row: { pool: string; pool_detail: any }) =>
  row.pool === 'spell_slot' ? 0 : row.pool === 'charges' ? (row.pool_detail?.scope === 'inventory' ? 2 : 1) : row.pool === 'item' ? 3 : 4;

// OK or Undo for one self-override activation. Only for a campaign DM/co-DM (or the site admin
// override, same as the rest of the campaign page). Idempotent: a second review changes nothing and
// answers 'already_reviewed'. Undo refunds every line the activation actually paid (capped at the live
// max for pools, the slot max for slots, no cap for item quantity), writes 'refund' rows pointing at
// the rows they reverse, and notes anything it couldn't refund.
export async function reviewOverride(
  reviewerUserId: string, campaignId: string, activationId: string, outcome: 'ok' | 'undo'
): Promise<ReviewResult> {
  const access = await getCampaignAccess({ query }, reviewerUserId, campaignId);
  if (!access?.canManage) throw new CampaignError("You can't manage this campaign.");
  if (!isUuid(activationId)) return { status: 'not_found', message: 'That use was not found.' };

  const owner = await query<{ character_id: string }>(
    `SELECT DISTINCT l.character_id FROM character_resource_ledger l JOIN characters c ON c.id = l.character_id
     WHERE l.activation_id = $1 AND l.override_kind = 'self_override' AND c.campaign_id = $2`,
    [activationId, campaignId]
  );
  const characterId = owner.rows[0]?.character_id;
  if (!characterId) return { status: 'not_found', message: 'That use was not found.' };
  // Before the transaction: the rule engine reads on its own connection. Archived pools resolve too.
  const loaded = outcome === 'undo' ? await loadPoolMaxima(characterId, true) : null;

  return withTransaction(async (client) => {
    const rows = (await client.query<any>(
      `SELECT * FROM character_resource_ledger WHERE activation_id = $1 AND override_kind = 'self_override' AND character_id = $2 ORDER BY created_at, id FOR UPDATE`,
      [activationId, characterId]
    )).rows;
    const first = rows[0];
    const base = { characterId, sourceLabel: first.source_label as string, roomId: (first.room_id as string | null) ?? null };
    const named = await client.query('SELECT name FROM characters WHERE id = $1', [characterId]);
    const characterName: string = named.rows[0]?.name ?? 'Someone';
    if (rows.some((row) => row.reviewed_at)) return { status: 'already_reviewed' as const, message: 'That use was already reviewed.', characterName, ...base };

    const refunded: string[] = [];
    const problems: string[] = [];
    if (outcome === 'undo') {
      const paid = rows.filter((row) => row.delta < 0).sort((a, b) => refundRank(a) - refundRank(b));
      for (const row of paid) {
        const n = -row.delta as number;
        const detail = row.pool_detail ?? {};
        let before: number | null = null;
        let after: number | null = null;
        if (row.pool === 'spell_slot') {
          const slot = await client.query(
            `SELECT current_slots, max_slots FROM character_spell_slots WHERE character_id = $1 AND slot_type = $2 AND slot_level = $3 FOR UPDATE`,
            [characterId, detail.slotType, detail.slotLevel]);
          if (slot.rows[0]) {
            before = slot.rows[0].current_slots; after = Math.min(slot.rows[0].max_slots, before! + n);
            await client.query(`UPDATE character_spell_slots SET current_slots = $4 WHERE character_id = $1 AND slot_type = $2 AND slot_level = $3`, [characterId, detail.slotType, detail.slotLevel, after]);
          }
        } else if (row.pool === 'charges') {
          const table = detail.scope === 'inventory' ? 'character_inventory_resources' : 'character_content_resources';
          const counter = await client.query(`SELECT current_value, max_value FROM ${table} WHERE id = $1 FOR UPDATE`, [detail.resourceId]);
          if (counter.rows[0]) {
            before = counter.rows[0].current_value; after = Math.min(counter.rows[0].max_value, before! + n);
            await client.query(`UPDATE ${table} SET current_value = $2 WHERE id = $1`, [detail.resourceId, after]);
          }
        } else if (row.pool === 'item') {
          const item = await client.query(`SELECT quantity FROM character_inventory_items WHERE id = $1 AND character_id = $2 FOR UPDATE`, [detail.inventoryId, characterId]);
          if (item.rows[0]) {
            before = item.rows[0].quantity; after = before! + n;
            await client.query(`UPDATE character_inventory_items SET quantity = $2 WHERE id = $1`, [detail.inventoryId, after]);
          }
        } else if (row.pool.startsWith(POOL_ROW_PREFIX)) {
          const key = row.pool.slice(POOL_ROW_PREFIX.length);
          const max = loaded?.maxima[key]?.max;
          const pool = await client.query(`SELECT current_value FROM character_resources WHERE character_id = $1 AND resource_key = $2 FOR UPDATE`, [characterId, row.pool]);
          if (pool.rows[0] && max !== undefined) {
            before = Math.max(0, Math.min(max, pool.rows[0].current_value)); after = Math.min(max, before + n);
            await client.query(`UPDATE character_resources SET current_value = $3, max_value = $4 WHERE character_id = $1 AND resource_key = $2`, [characterId, row.pool, after, max]);
          }
        }
        if (before === null || after === null) {
          problems.push(`Couldn't refund ${n} ${row.label} (it's gone)`);
          continue;
        }
        const actual = after - before;
        if (actual < n) problems.push(`Refunded ${actual} of ${n} ${row.label} (it was already at its maximum)`);
        if (actual > 0) refunded.push(`${actual} ${row.label}`);
        await writeLedger(client, {
          characterId, pool: row.pool, poolDetail: detail, label: row.label, delta: actual, before, after, reason: 'refund',
          sourceContentId: row.source_content_id, sourceLabel: row.source_label, activationId, actorUserId: reviewerUserId, roomId: row.room_id, refundOf: row.id
        });
      }
    }
    await client.query(
      `UPDATE character_resource_ledger SET reviewed_at = now(), reviewed_by_user_id = $2, review_outcome = $3
       WHERE activation_id = $1 AND override_kind = 'self_override' AND character_id = $4`,
      [activationId, reviewerUserId, outcome === 'ok' ? 'ok' : 'undone', characterId]
    );
    if (outcome === 'ok') return { status: 'ok' as const, message: 'Marked as OK.', characterName, ...base };
    return { status: 'undone' as const, message: undoMessage(refunded, problems), characterName, refunded, ...base };
  });
}
