import crypto from 'node:crypto';
import { planFork, remapRulesKeys, type ForkEntry, type ForkPlan, type ForkReason } from '$lib/library/rules';
import type { ContentType } from '$lib/types/content';

// Fork on leave (plans/dndchar/homebrew-library, unit G). Library content is REFERENCED while its owner is a member
// of a campaign. When the owner leaves (or the DM presses "Keep a campaign copy"), whatever of theirs the campaign
// still uses is COPIED into campaign ownership and the campaign's uses are re-pointed at the copies. Nothing is
// deleted, history is never rewritten, and the owner's own library is never touched.
//
// This file deliberately imports no $lib/server code except through the `db` argument (a pg client inside the
// caller's transaction), so the repair script can run it with a plain pg client.
//
// LOCK ORDER (follows campaigns.ts and cost-engine.ts). The caller already holds the campaign's member rows
// (lockCampaign). The fork then locks:
//   1. the campaign's `characters` rows, FOR UPDATE in ascending id (the sheet Save and deck draw order);
//   2. content counters (character_content_resources) -> character_content_instances;
//   3. inventory counters (character_inventory_resources) -> character_inventory_items;
//   4. active_character_effects, campaign_decks, find_table_entries and the content tables (no one locks these first).
// It never touches character_turn_state, spell slots or character_resources (hp, pools). Each group is locked in
// ascending id with an explicit SELECT ... FOR UPDATE before its UPDATE. One known inversion remains, shared with the
// sheet Save and deck draws: the cost engine locks counters/items first and then needs a KEY SHARE on the characters
// row, so a cost spend racing a leave can deadlock. Postgres aborts one side cleanly (the leave rolls back whole).
//
// Idempotent: a copy is found by (campaign_id, forked_from_content_id) and reused, never refreshed, because the DM may
// have edited it. A second run only moves uses that newly reference the original.

export type ForkDb = { query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> };

export type ForkOptions = {
  reason: ForkReason;
  actorUserId: string | null;
  /** Work out the plan and report it, write nothing (the repair script's --dry-run). */
  dryRun?: boolean;
};

export type ForkSummary = {
  ownerUserId: string;
  ownerName: string;
  reason: ForkReason;
  dryRun: boolean;
  /** New copies made by this run (including internal ones such as action containers). */
  copies: Array<{ type: ContentType; name: string }>;
  /** Originals that already had a copy here, which was reused as it is. */
  reused: number;
  /** Rows re-pointed, by kind. */
  repointed: Record<string, number>;
  /** Plain-words notes about uses left on the original (for example the character already holds the copy). */
  skipped: string[];
  /** Characters whose sheet changed, so open sheets and VTT tokens can re-sync. */
  touchedCharacterIds: string[];
};

/** What the leave/remove flow shows when the fork fails. The real error is logged, never shown. */
export const forkFailureMessage = (ownerName: string) => `Couldn't keep copies of ${ownerName}'s homebrew for this campaign. Nothing was changed.`;

const pairs = (record: Record<string, string>) => ({ from: Object.keys(record), to: Object.values(record) });

// ---------------------------------------------------------------- finding what the campaign uses

type Use = { contentId: string; kind: string; ownerUserId: string };

// Every place a campaign points at one of its own members' personal entries. Everything here is a ROOT of the fork.
// `$2` limits it to one owner (null = every owner, for the repair path).
const USES_SQL = `
  SELECT src.content_id, src.kind, c.owner_user_id
  FROM (
    SELECT i.source_content_id AS content_id, 'inventory' AS kind FROM character_inventory_items i
      JOIN characters ch ON ch.id = i.character_id WHERE ch.campaign_id = $1 AND i.source_content_id IS NOT NULL
    UNION ALL
    SELECT x.content_id, 'known' FROM character_content_instances x
      JOIN characters ch ON ch.id = x.character_id WHERE ch.campaign_id = $1
    UNION ALL
    SELECT e.container_id, 'effect' FROM active_character_effects e
      JOIN characters ch ON ch.id = e.character_id WHERE ch.campaign_id = $1
    UNION ALL
    SELECT d.deck_content_id, 'deck' FROM campaign_decks d WHERE d.campaign_id = $1
    UNION ALL
    SELECT f.item_id, 'forage' FROM find_table_entries f JOIN find_tables t ON t.id = f.find_table_id WHERE t.campaign_id = $1
    UNION ALL
    SELECT g.granted_content_id, 'grant' FROM content_grants g
      JOIN content_definitions s ON s.id = g.source_content_id WHERE s.scope = 'campaign' AND s.campaign_id = $1
    UNION ALL
    SELECT a.spell_content_id, 'spell access' FROM content_spell_access a
      JOIN content_definitions s ON s.id = a.owner_content_id WHERE s.scope = 'campaign' AND s.campaign_id = $1
    UNION ALL
    SELECT st.effect_container_id, 'action step' FROM action_steps st
      JOIN content_definitions s ON s.id = st.container_id
      WHERE s.scope = 'campaign' AND s.campaign_id = $1 AND st.effect_container_id IS NOT NULL
  ) src JOIN content_definitions c ON c.id = src.content_id
  WHERE c.scope = 'personal' AND ($2::uuid IS NULL OR c.owner_user_id = $2::uuid)`;

/** Rules text of the decks the campaign owns (authored ones and earlier copies). A condition key appears quoted in it. */
async function campaignDeckRules(db: ForkDb, campaignId: string): Promise<Array<{ id: string; rules: unknown }>> {
  const rows = await db.query(
    `SELECT d.content_id AS id, d.rules_json AS rules FROM deck_definitions d
     JOIN content_definitions c ON c.id = d.content_id WHERE c.scope = 'campaign' AND c.campaign_id = $1 ORDER BY d.content_id
     FOR UPDATE OF c, d`, [campaignId]);
  // Locked (content row first, as the deck editor does) so a DM saving a deck mid-fork can't have the edit overwritten.
  return rows.rows;
}

const namesKey = (rulesText: string, key: string) => rulesText.includes(JSON.stringify(key));

async function loadUses(db: ForkDb, campaignId: string, ownerUserId: string | null): Promise<Use[]> {
  const rows = await db.query(USES_SQL, [campaignId, ownerUserId]);
  const uses: Use[] = rows.rows.map((row) => ({ contentId: row.content_id, kind: row.kind, ownerUserId: row.owner_user_id }));
  // Condition keys inside the campaign's own decks' rules (stored by key, not id).
  const conditions = await db.query(
    `SELECT id, content_key, owner_user_id FROM content_definitions
     WHERE content_type = 'condition' AND scope = 'personal' AND ($1::uuid IS NULL OR owner_user_id = $1::uuid)`, [ownerUserId]);
  if (conditions.rows.length) {
    for (const deck of await campaignDeckRules(db, campaignId)) {
      const text = JSON.stringify(deck.rules);
      for (const condition of conditions.rows) {
        if (namesKey(text, condition.content_key)) uses.push({ contentId: condition.id, kind: 'deck rule', ownerUserId: condition.owner_user_id });
      }
    }
  }
  return uses;
}

/** How many places in this campaign still point at the owner's library (the "N uses" on the campaign libraries page). */
export async function countLibraryUsesInCampaign(db: ForkDb, campaignId: string, ownerUserId: string): Promise<number> {
  return (await loadUses(db, campaignId, ownerUserId)).length;
}

// ---------------------------------------------------------------- the fork

async function loadOwnerEntries(db: ForkDb, ownerUserId: string): Promise<ForkEntry[]> {
  const rows = await db.query(
    `SELECT id, content_key, content_type, name, scope, owner_user_id, is_archived FROM content_definitions
     WHERE scope = 'personal' AND owner_user_id = $1 ORDER BY id`, [ownerUserId]);
  return rows.rows.map((row) => ({
    id: row.id, key: row.content_key, type: row.content_type, name: row.name, scope: row.scope,
    ownerUserId: row.owner_user_id, isArchived: row.is_archived
  }));
}

// References between the owner's own entries: grants, spell access, action containers, action step effects, and
// condition keys named by the owner's personal decks.
async function loadEdges(db: ForkDb, ownerUserId: string, entries: ForkEntry[]): Promise<Array<{ from: string; to: string }>> {
  const mine = `s.scope = 'personal' AND s.owner_user_id = $1`;
  const rows = await db.query(
    `SELECT g.source_content_id AS "from", g.granted_content_id AS "to" FROM content_grants g
       JOIN content_definitions s ON s.id = g.source_content_id WHERE ${mine}
     UNION SELECT a.owner_content_id, a.spell_content_id FROM content_spell_access a
       JOIN content_definitions s ON s.id = a.owner_content_id WHERE ${mine}
     UNION SELECT l.content_id, l.action_container_id FROM content_action_links l
       JOIN content_definitions s ON s.id = l.content_id WHERE ${mine} AND l.action_container_id IS NOT NULL
     UNION SELECT st.container_id, st.effect_container_id FROM action_steps st
       JOIN content_definitions s ON s.id = st.container_id WHERE ${mine} AND st.container_id IS NOT NULL AND st.effect_container_id IS NOT NULL`,
    [ownerUserId]);
  const edges: Array<{ from: string; to: string }> = rows.rows.map((row) => ({ from: row.from, to: row.to }));
  const conditions = entries.filter((entry) => entry.type === 'condition');
  if (conditions.length) {
    const decks = await db.query(
      `SELECT d.content_id, d.rules_json::text AS rules FROM deck_definitions d
       JOIN content_definitions s ON s.id = d.content_id WHERE ${mine}`, [ownerUserId]);
    for (const deck of decks.rows) {
      for (const condition of conditions) if (namesKey(deck.rules, condition.key)) edges.push({ from: deck.content_id, to: condition.id });
    }
  }
  return edges;
}

/**
 * Copies the owner's personal content that `campaignId` uses into campaign ownership and re-points the campaign's uses.
 * The caller owns the transaction and has locked the campaign's member rows. Returns what it did; the caller does the
 * after-commit steps (libraryForkAnnounce.ts). Throws on any problem so the caller rolls everything back.
 */
export async function forkLibraryContent(db: ForkDb, campaignId: string, ownerUserId: string, opts: ForkOptions): Promise<ForkSummary> {
  const owner = (await db.query('SELECT display_name FROM users WHERE id = $1', [ownerUserId])).rows[0];
  if (!owner) throw new Error(`Fork: user ${ownerUserId} not found.`);
  const summary: ForkSummary = {
    ownerUserId, ownerName: owner.display_name, reason: opts.reason, dryRun: Boolean(opts.dryRun),
    copies: [], reused: 0, repointed: {}, skipped: [], touchedCharacterIds: []
  };

  // Step 1: lock the campaign's characters in ascending id, before reading what they hold.
  await db.query('SELECT id FROM characters WHERE campaign_id = $1 ORDER BY id FOR UPDATE', [campaignId]);

  // Steps 2 and 3: the roots, then the closure and the copy plan (pure).
  const uses = await loadUses(db, campaignId, ownerUserId);
  if (!uses.length) return summary;
  const entries = await loadOwnerEntries(db, ownerUserId);
  const existing = await db.query(
    `SELECT forked_from_content_id AS original_id, id AS copy_id, content_key FROM content_definitions
     WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL`, [campaignId]);
  const resourcesOf = async (ids: string[]) => (await db.query(
    'SELECT content_id, id, resource_key AS key FROM content_resource_definitions WHERE content_id = ANY($1::uuid[])', [ids])).rows
    .map((row) => ({ contentId: row.content_id as string, id: row.id as string, key: row.key as string }));
  const plan = planFork({
    campaignId, ownerUserId, reason: opts.reason, entries,
    roots: [...new Set(uses.map((use) => use.contentId))],
    edges: await loadEdges(db, ownerUserId, entries),
    existingCopies: existing.rows.map((row) => ({ originalId: row.original_id, copyId: row.copy_id, copyKey: row.content_key })),
    originalResources: await resourcesOf(entries.map((entry) => entry.id)),
    copyResources: await resourcesOf(existing.rows.map((row) => row.copy_id)),
    newId: () => crypto.randomUUID()
  });
  summary.copies = plan.copies.map((copy) => ({ type: copy.type, name: copy.name }));
  summary.reused = plan.reused.length;
  if (opts.dryRun || !Object.keys(plan.idRemap).length) return summary;

  const at = new Date().toISOString();
  const forkNote = JSON.stringify({ fork: { fromOwnerUserId: ownerUserId, fromOwnerName: owner.display_name, at, reason: opts.reason, actorUserId: opts.actorUserId } });

  // Step 4: copy. All content rows first (grants and the like point at other copies), then their children.
  for (const copy of plan.copies) await insertCopyRow(db, campaignId, copy, plan, forkNote);
  for (const copy of plan.copies) await insertCopyChildren(db, copy, plan);

  // Step 5: re-point uses in this campaign. UPDATEs only.
  const touched = new Set<string>();
  await repointUses(db, campaignId, plan, summary, touched);
  summary.touchedCharacterIds = [...touched].sort();
  return summary;
}

async function insertCopyRow(db: ForkDb, campaignId: string, copy: ForkPlan['copies'][number], plan: ForkPlan, forkNote: string): Promise<void> {
  // Every column is copied except the identity, ownership and scope ones set here. No personal owner: a campaign copy
  // can never show in the leaver's library or block deleting their user.
  await db.query(
    `INSERT INTO content_definitions (id, content_key, content_type, name, description, source_kind, source_ref, owner_user_id, metadata_json,
       is_archived, activation_type, cost_json, duration_type, duration_rounds, requires_concentration, expiry_boundary, stack_behavior,
       is_system, scope, hidden_from_players, campaign_id, forked_from_content_id)
     SELECT $1, $2, content_type, name, description, source_kind, source_ref, NULL, metadata_json || $3::jsonb,
       is_archived, activation_type, cost_json, duration_type, duration_rounds, requires_concentration, expiry_boundary, stack_behavior,
       is_system, 'campaign', hidden_from_players, $4, id
     FROM content_definitions WHERE id = $5`,
    [copy.copyId, copy.copyKey, forkNote, campaignId, copy.originalId]);
  // The 1:1 row. If a column is ever added to these tables, add it here (the gated test compares original and copy).
  if (copy.type === 'item') {
    await db.query(
      `INSERT INTO item_definitions (content_id, category, equipment_type, requires_attunement, ac_bonus, to_hit_bonus, damage_bonus, attack_ability, damage_rolls)
       SELECT $1, category, equipment_type, requires_attunement, ac_bonus, to_hit_bonus, damage_bonus, attack_ability, damage_rolls
       FROM item_definitions WHERE content_id = $2`, [copy.copyId, copy.originalId]);
  } else if (copy.type === 'spell') {
    await db.query(
      `INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, ritual, concentration, classes,
         higher_level, resolution_type, damage_type, base_dice, save_ability, save_effect, scaling_json)
       SELECT $1, spell_level, school, casting_time, spell_range, components, duration, ritual, concentration, classes,
         higher_level, resolution_type, damage_type, base_dice, save_ability, save_effect, scaling_json
       FROM spell_definitions WHERE content_id = $2`, [copy.copyId, copy.originalId]);
  } else if (copy.type === 'deck') {
    // The deck's rules name conditions by key: point them at the copies of any condition in this fork. The
    // deck_definitions.campaign_id mirror is kept in step with content_definitions.campaign_id.
    const rules = (await db.query('SELECT rules_json FROM deck_definitions WHERE content_id = $1', [copy.originalId])).rows[0]?.rules_json;
    await db.query('INSERT INTO deck_definitions (content_id, rules_json, campaign_id) VALUES ($1, $2::jsonb, $3)',
      [copy.copyId, JSON.stringify(remapRulesKeys(rules ?? {}, plan.keyRemap)), campaignId]);
  }
}

async function insertCopyChildren(db: ForkDb, copy: ForkPlan['copies'][number], plan: ForkPlan): Promise<void> {
  const ids = pairs(plan.idRemap);
  const resources = pairs(plan.resourceRemap);
  // Modifier definitions are global, so the links keep their modifier ids.
  await db.query(
    `INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, value_override_expression, condition_expression, priority, sort_order)
     SELECT $1, modifier_id, activation_type, value_override_expression, condition_expression, priority, sort_order
     FROM content_modifier_links WHERE content_id = $2`, [copy.copyId, copy.originalId]);
  // Charge counters keep their ORIGINAL keys (the plan matches on key), with the ids the plan chose.
  for (const resource of plan.newResources.filter((row) => row.copyContentId === copy.copyId)) {
    await db.query(
      `INSERT INTO content_resource_definitions (id, content_id, resource_key, label, max_value_expression, recharge_period)
       SELECT $1, $2, resource_key, label, max_value_expression, recharge_period FROM content_resource_definitions WHERE id = $3`,
      [resource.copyId, copy.copyId, resource.originalId]);
  }
  // Grants to another entry in this fork point at its copy; grants to anything else (global) stay as they are.
  await db.query(
    `INSERT INTO content_grants (source_content_id, granted_content_id, activation_type)
     SELECT $1, COALESCE(m.copy_id, g.granted_content_id), g.activation_type FROM content_grants g
     LEFT JOIN unnest($3::uuid[], $4::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = g.granted_content_id
     WHERE g.source_content_id = $2 ON CONFLICT DO NOTHING`, [copy.copyId, copy.originalId, ids.from, ids.to]);
  await db.query(
    `INSERT INTO content_spell_access (owner_content_id, spell_content_id, access_type, availability_type, resource_definition_id, resource_cost_expression,
       use_limit_expression, recharge_period, cast_level_mode, fixed_cast_level, save_dc_mode, fixed_save_dc, spell_attack_mode, fixed_spell_attack_bonus, sort_order)
     SELECT $1, COALESCE(sm.copy_id, a.spell_content_id), a.access_type, a.availability_type, COALESCE(rm.copy_id, a.resource_definition_id), a.resource_cost_expression,
       a.use_limit_expression, a.recharge_period, a.cast_level_mode, a.fixed_cast_level, a.save_dc_mode, a.fixed_save_dc, a.spell_attack_mode, a.fixed_spell_attack_bonus, a.sort_order
     FROM content_spell_access a
     LEFT JOIN unnest($3::uuid[], $4::uuid[]) AS sm(orig_id, copy_id) ON sm.orig_id = a.spell_content_id
     LEFT JOIN unnest($5::uuid[], $6::uuid[]) AS rm(orig_id, copy_id) ON rm.orig_id = a.resource_definition_id
     WHERE a.owner_content_id = $2 ON CONFLICT DO NOTHING`, [copy.copyId, copy.originalId, ids.from, ids.to, resources.from, resources.to]);
  // Action links point at the copied action containers; the steps of a copied container follow it, with their
  // "apply this condition" targets re-pointed.
  await db.query(
    `INSERT INTO content_action_links (content_id, action_id, trigger_type, sort_order, action_container_id)
     SELECT $1, l.action_id, l.trigger_type, l.sort_order, COALESCE(m.copy_id, l.action_container_id) FROM content_action_links l
     LEFT JOIN unnest($3::uuid[], $4::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = l.action_container_id
     WHERE l.content_id = $2 ON CONFLICT DO NOTHING`, [copy.copyId, copy.originalId, ids.from, ids.to]);
  if (copy.type === 'action') {
    await db.query(
      `INSERT INTO action_steps (action_id, step_type, operation, target_type, target_key, value_expression, effect_id, target_mode, label,
         sort_order, metadata_json, container_id, effect_container_id)
       SELECT st.action_id, st.step_type, st.operation, st.target_type, st.target_key, st.value_expression, st.effect_id, st.target_mode, st.label,
         st.sort_order, st.metadata_json, $1, COALESCE(m.copy_id, st.effect_container_id) FROM action_steps st
       LEFT JOIN unnest($3::uuid[], $4::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = st.effect_container_id
       WHERE st.container_id = $2 ORDER BY st.sort_order`, [copy.copyId, copy.originalId, ids.from, ids.to]);
  }
}

// Step 5. Every statement is an UPDATE that moves a pointer from an original to its copy, only inside this campaign.
// Where moving would break a unique key (the character already holds the copy), the row stays on the original, which
// still resolves, and it is reported.
async function repointUses(db: ForkDb, campaignId: string, plan: ForkPlan, summary: ForkSummary, touched: Set<string>): Promise<void> {
  const ids = pairs(plan.idRemap);
  const resources = pairs(plan.resourceRemap);
  const count = (kind: string, n: number) => { if (n) summary.repointed[kind] = (summary.repointed[kind] ?? 0) + n; };
  // Rows the NOT EXISTS guards skipped are the ones still pointing at an original after the UPDATE. They keep working
  // (the original still resolves), so this only reports them, as the known-spell skip above does.
  const reportLeft = async (sql: string, what: string, why: string) => {
    const left = (await db.query(sql, [campaignId, ids.from, ids.to])).rows[0]?.n ?? 0;
    if (left) summary.skipped.push(`${left} ${what}${left === 1 ? '' : 's'} stayed on the original because ${why}.`);
  };

  // Known spells, feats and features. Same instance id, so preparation, notes and counters stay with it.
  const instances = await db.query(
    `SELECT x.id, x.character_id, m.copy_id, (SELECT count(*) FROM character_content_instances y WHERE y.character_id = x.character_id AND y.content_id = m.copy_id)::int AS held
     FROM character_content_instances x JOIN characters ch ON ch.id = x.character_id
     JOIN unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = x.content_id
     WHERE ch.campaign_id = $1 ORDER BY x.id`, [campaignId, ids.from, ids.to]);
  const movable = instances.rows.filter((row) => row.held === 0);
  if (instances.rows.length > movable.length) {
    summary.skipped.push(`${instances.rows.length - movable.length} known spell, feat or feature stayed on the original because the character already has the copy.`);
  }
  if (movable.length) {
    const instanceIds = movable.map((row) => row.id);
    // Counters first (lock order), then the instance rows.
    // Known quirk: this only remaps counters that point at the original. If the original gained a counter after the first
    // fork, the moved instance's counter for it keeps pointing at the original's resource (the copy has no matching row).
    await db.query('SELECT id FROM character_content_resources WHERE character_content_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [instanceIds]);
    await db.query(
      `UPDATE character_content_resources r SET resource_definition_id = m.copy_id
       FROM unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id)
       WHERE r.character_content_id = ANY($1::uuid[]) AND r.resource_definition_id = m.orig_id`, [instanceIds, resources.from, resources.to]);
    await db.query('SELECT id FROM character_content_instances WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [instanceIds]);
    await db.query(
      `UPDATE character_content_instances x SET content_id = m.copy_id
       FROM unnest($1::uuid[], $2::uuid[]) AS m(instance_id, copy_id) WHERE x.id = m.instance_id`,
      [instanceIds, movable.map((row) => row.copy_id)]);
    for (const row of movable) touched.add(row.character_id);
    count('known spells, feats and features', movable.length);
  }

  // Held items and their charges (current and max values are kept, only the definition they count against moves).
  const items = await db.query(
    `SELECT i.id, i.character_id, m.copy_id FROM character_inventory_items i JOIN characters ch ON ch.id = i.character_id
     JOIN unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = i.source_content_id
     WHERE ch.campaign_id = $1 ORDER BY i.id`, [campaignId, ids.from, ids.to]);
  if (items.rows.length) {
    const itemIds = items.rows.map((row) => row.id);
    await db.query('SELECT id FROM character_inventory_resources WHERE inventory_item_id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [itemIds]);
    await db.query(
      `UPDATE character_inventory_resources r SET resource_definition_id = m.copy_id
       FROM unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id)
       WHERE r.inventory_item_id = ANY($1::uuid[]) AND r.resource_definition_id = m.orig_id`, [itemIds, resources.from, resources.to]);
    await db.query('SELECT id FROM character_inventory_items WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [itemIds]);
    await db.query(
      `UPDATE character_inventory_items i SET source_content_id = m.copy_id
       FROM unnest($1::uuid[], $2::uuid[]) AS m(item_id, copy_id) WHERE i.id = m.item_id`,
      [itemIds, items.rows.map((row) => row.copy_id)]);
    for (const row of items.rows) touched.add(row.character_id);
    count('held items', items.rows.length);
  }

  // Applied conditions. The row id is unchanged, so a deck draw's undo (effectRowId) still finds it.
  const effects = await db.query(
    `UPDATE active_character_effects e SET container_id = m.copy_id
     FROM characters ch, unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id)
     WHERE ch.id = e.character_id AND ch.campaign_id = $1 AND e.container_id = m.orig_id RETURNING e.character_id`, [campaignId, ids.from, ids.to]);
  for (const row of effects.rows) touched.add(row.character_id);
  count('applied conditions', effects.rows.length);

  // Enabled decks (the campaign_decks key is (campaign, deck), so a campaign already enabling the copy keeps both rows).
  const decks = await db.query(
    `UPDATE campaign_decks d SET deck_content_id = m.copy_id FROM unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id)
     WHERE d.campaign_id = $1 AND d.deck_content_id = m.orig_id
       AND NOT EXISTS (SELECT 1 FROM campaign_decks y WHERE y.campaign_id = d.campaign_id AND y.deck_content_id = m.copy_id)`, [campaignId, ids.from, ids.to]);
  count('enabled decks', decks.rowCount ?? 0);
  await reportLeft(`SELECT count(*)::int AS n FROM campaign_decks d JOIN unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = d.deck_content_id WHERE d.campaign_id = $1`,
    'enabled deck', 'the campaign already enables the copy');

  // Forage entries (the key is (table, item), same care).
  const forage = await db.query(
    `UPDATE find_table_entries f SET item_id = m.copy_id
     FROM find_tables t, unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id)
     WHERE t.id = f.find_table_id AND t.campaign_id = $1 AND f.item_id = m.orig_id
       AND NOT EXISTS (SELECT 1 FROM find_table_entries y WHERE y.find_table_id = f.find_table_id AND y.item_id = m.copy_id)`, [campaignId, ids.from, ids.to]);
  count('forage entries', forage.rowCount ?? 0);
  await reportLeft(`SELECT count(*)::int AS n FROM find_table_entries f JOIN find_tables t ON t.id = f.find_table_id
    JOIN unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = f.item_id WHERE t.campaign_id = $1`,
    'forage entry', 'the table already has the copy');

  // References FROM the campaign's own entries (the copies and its authored decks) to the owner's entries.
  const grants = await db.query(
    `UPDATE content_grants g SET granted_content_id = m.copy_id
     FROM content_definitions s, unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id)
     WHERE s.id = g.source_content_id AND s.scope = 'campaign' AND s.campaign_id = $1 AND g.granted_content_id = m.orig_id
       AND NOT EXISTS (SELECT 1 FROM content_grants y WHERE y.source_content_id = g.source_content_id AND y.granted_content_id = m.copy_id AND y.activation_type = g.activation_type)`,
    [campaignId, ids.from, ids.to]);
  const access = await db.query(
    `UPDATE content_spell_access a SET spell_content_id = m.copy_id
     FROM content_definitions s, unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id)
     WHERE s.id = a.owner_content_id AND s.scope = 'campaign' AND s.campaign_id = $1 AND a.spell_content_id = m.orig_id
       AND NOT EXISTS (SELECT 1 FROM content_spell_access y WHERE y.owner_content_id = a.owner_content_id AND y.spell_content_id = m.copy_id AND y.access_type = a.access_type)`,
    [campaignId, ids.from, ids.to]);
  const steps = await db.query(
    `UPDATE action_steps st SET effect_container_id = m.copy_id
     FROM content_definitions s, unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id)
     WHERE s.id = st.container_id AND s.scope = 'campaign' AND s.campaign_id = $1 AND st.effect_container_id = m.orig_id`, [campaignId, ids.from, ids.to]);
  await reportLeft(`SELECT count(*)::int AS n FROM content_grants g JOIN content_definitions s ON s.id = g.source_content_id AND s.scope = 'campaign' AND s.campaign_id = $1
    JOIN unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = g.granted_content_id`, 'grant on a campaign entry', 'it already grants the copy');
  await reportLeft(`SELECT count(*)::int AS n FROM content_spell_access a JOIN content_definitions s ON s.id = a.owner_content_id AND s.scope = 'campaign' AND s.campaign_id = $1
    JOIN unnest($2::uuid[], $3::uuid[]) AS m(orig_id, copy_id) ON m.orig_id = a.spell_content_id`, 'spell access on a campaign entry', 'it already has access to the copy');
  count('references from campaign entries', (grants.rowCount ?? 0) + (access.rowCount ?? 0) + (steps.rowCount ?? 0));

  // Condition keys in the campaign's decks' rules. Rewritten only when something changes, so a DM's other edits stay.
  let rewritten = 0;
  for (const deck of await campaignDeckRules(db, campaignId)) {
    const next = remapRulesKeys(deck.rules, plan.keyRemap);
    if (JSON.stringify(next) === JSON.stringify(deck.rules)) continue;
    await db.query('UPDATE deck_definitions SET rules_json = $2::jsonb, updated_at = now() WHERE content_id = $1', [deck.id, JSON.stringify(next)]);
    rewritten += 1;
  }
  count('deck rules', rewritten);
}

/**
 * The repair path: forks every former member's content that this campaign still uses (people who left before the fork
 * existed). One transaction per campaign is the caller's job. Returns one summary per former owner.
 */
export async function forkFormerMembersContent(db: ForkDb, campaignId: string, opts: { actorUserId?: string | null; dryRun?: boolean } = {}): Promise<ForkSummary[]> {
  // Characters first, as in the fork, so what is read below can't change under us.
  await db.query('SELECT id FROM characters WHERE campaign_id = $1 ORDER BY id FOR UPDATE', [campaignId]);
  const members = new Set((await db.query('SELECT user_id FROM campaign_members WHERE campaign_id = $1', [campaignId])).rows.map((row) => row.user_id));
  const owners = [...new Set((await loadUses(db, campaignId, null)).map((use) => use.ownerUserId))].filter((id) => !members.has(id)).sort();
  const out: ForkSummary[] = [];
  for (const ownerUserId of owners) {
    out.push(await forkLibraryContent(db, campaignId, ownerUserId, { reason: 'repair', actorUserId: opts.actorUserId ?? null, dryRun: opts.dryRun }));
  }
  return out;
}

// ---------------------------------------------------------------- restore and sheet Save support

/**
 * The campaign copies a character's campaign has, as maps from the ORIGINAL to the copy. Used by a snapshot restore
 * and the sheet's effect Save: history keeps the original ids and keys, but inside a campaign that has a copy the
 * live character should land on the copy. Empty when the character has no live campaign (the originals still resolve).
 */
export type CopyMap = {
  /** original content id -> copy content id */
  ids: Map<string, string>;
  /** original content key -> copy content key */
  keys: Map<string, string>;
  /** original resource definition id -> the copy's resource definition id (same resource key) */
  resources: Map<string, string>;
};

export async function loadCampaignCopyMap(db: ForkDb, characterId: string): Promise<CopyMap> {
  const map: CopyMap = { ids: new Map(), keys: new Map(), resources: new Map() };
  const campaign = (await db.query(
    `SELECT cp.id FROM characters ch JOIN campaigns cp ON cp.id = ch.campaign_id AND NOT cp.is_archived WHERE ch.id = $1`, [characterId])).rows[0];
  if (!campaign) return map;
  const copies = await db.query(
    `SELECT f.forked_from_content_id AS original_id, f.id AS copy_id, o.content_key AS original_key, f.content_key AS copy_key
     FROM content_definitions f JOIN content_definitions o ON o.id = f.forked_from_content_id
     WHERE f.campaign_id = $1 AND f.forked_from_content_id IS NOT NULL`, [campaign.id]);
  for (const row of copies.rows) { map.ids.set(row.original_id, row.copy_id); map.keys.set(row.original_key, row.copy_key); }
  if (copies.rows.length) {
    const resources = await db.query(
      `SELECT o.id AS original_id, c.id AS copy_id FROM content_definitions f
       JOIN content_resource_definitions o ON o.content_id = f.forked_from_content_id
       JOIN content_resource_definitions c ON c.content_id = f.id AND c.resource_key = o.resource_key
       WHERE f.campaign_id = $1 AND f.forked_from_content_id IS NOT NULL`, [campaign.id]);
    for (const row of resources.rows) map.resources.set(row.original_id, row.copy_id);
  }
  return map;
}
