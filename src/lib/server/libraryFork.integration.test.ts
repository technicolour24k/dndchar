import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed checks for fork on leave and "Keep a campaign copy" (homebrew library unit G): every root type is copied and
// re-pointed, the fork is idempotent and never overwrites DM edits, a failure rolls the whole leave back, a stale open
// sheet cannot undo it, a snapshot restore lands on the copies, and the pickers offer the copies.
// SKIPPED unless LIBRARY_DB_TEST=1. Local DB only (guarded below). Calls the services directly with throwaway users.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   LIBRARY_DB_TEST=1 npx vitest run src/lib/server/libraryFork.integration.test.ts
const enabled = process.env.LIBRARY_DB_TEST === '1';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const code = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
const fd = (fields: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};
const hex = () => crypto.randomBytes(3).toString('hex');

describe.skipIf(!enabled)('fork on leave and Keep a campaign copy', () => {
  const tag = `zzfork${crypto.randomBytes(4).toString('hex')}`;
  let q: <T = any>(text: string, params?: unknown[]) => Promise<{ rows: T[] }>;
  let withTransaction: typeof import('$lib/server/db').withTransaction;
  let campaigns: typeof import('./services/campaigns');
  let library: typeof import('./services/library');
  let libraryFork: typeof import('./services/libraryFork');
  let characters: typeof import('./services/characters');
  let catalogue: typeof import('./services/catalogue');
  let decks: typeof import('./services/decks');
  let homebrew: typeof import('./services/library-campaign');
  let ruleEngine: typeof import('./services/rule-engine');
  let forage: typeof import('./services/forage');
  let invalidateReferenceData: (reason: string) => void;
  const campaignIds: string[] = [];
  const triggers: string[] = [];

  beforeAll(async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }
    const db = await import('$lib/server/db');
    q = db.query as typeof q;
    withTransaction = db.withTransaction;
    ({ invalidateReferenceData } = await import('$lib/server/cache/referenceData'));
    campaigns = await import('./services/campaigns');
    library = await import('./services/library');
    libraryFork = await import('./services/libraryFork');
    characters = await import('./services/characters');
    catalogue = await import('./services/catalogue');
    decks = await import('./services/decks');
    homebrew = await import('./services/library-campaign');
    ruleEngine = await import('./services/rule-engine');
    forage = await import('./services/forage');
  });

  afterAll(async () => {
    if (!enabled || !q) return;
    for (const name of triggers) await q(`DROP TRIGGER IF EXISTS ${name} ON campaign_decks`);
    await q(`DROP FUNCTION IF EXISTS ${tag}_fail()`);
    const ids = campaignIds.length ? campaignIds : ['00000000-0000-0000-0000-000000000000'];
    const mine = `(SELECT id FROM users WHERE email LIKE '${tag}%')`;
    const content = `(SELECT id FROM content_definitions WHERE name LIKE '%${tag}%')`;
    await q('DELETE FROM deck_draws WHERE campaign_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM campaign_decks WHERE campaign_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM campaign_library_settings WHERE campaign_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM finds WHERE campaign_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM find_table_entries WHERE find_table_id IN (SELECT id FROM find_tables WHERE campaign_id = ANY($1::uuid[]))', [ids]);
    await q('DELETE FROM find_tables WHERE campaign_id = ANY($1::uuid[])', [ids]);
    await q(`DELETE FROM active_character_effects WHERE character_id IN (SELECT id FROM characters WHERE owner_user_id IN ${mine})`);
    await q(`DELETE FROM character_versions WHERE character_id IN (SELECT id FROM characters WHERE owner_user_id IN ${mine})`);
    await q(`DELETE FROM characters WHERE owner_user_id IN ${mine}`);
    // Restrict foreign keys first: steps pointing at conditions, action links, spell access, deck rows.
    await q(`DELETE FROM action_steps WHERE container_id IN ${content} OR effect_container_id IN ${content}`);
    await q(`DELETE FROM content_action_links WHERE content_id IN ${content} OR action_container_id IN ${content}`);
    await q(`DELETE FROM content_spell_access WHERE owner_content_id IN ${content} OR spell_content_id IN ${content}`);
    await q(`DELETE FROM deck_definitions WHERE content_id IN ${content}`);
    await q(`DELETE FROM content_modifier_links WHERE content_id IN ${content}`);
    await q(`UPDATE content_definitions SET forked_from_content_id = NULL WHERE name LIKE '%${tag}%'`);
    await q(`DELETE FROM content_definitions WHERE name LIKE '%${tag}%'`);
    await q('DELETE FROM campaign_members WHERE campaign_id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM campaigns WHERE id = ANY($1::uuid[])', [ids]);
    await q('DELETE FROM users WHERE email LIKE $1', [`${tag}%`]);
  });

  // ------------------------------------------------------------------ fixture

  type World = Awaited<ReturnType<typeof buildWorld>>;

  /**
   * One campaign (C1) with a DM, player A (whose library is on) and player B. A owns: a charged sword that grants a feat
   * and has an action applying a condition, a wand granting a spell by charges, a feat with counters, a spell, two
   * conditions, a deck naming one of them, and a forage item. C1 uses all of it: B holds the items, knows the spell and
   * feat, has the condition on; A's deck is enabled; the forage item is on a find table; and a campaign-authored
   * deck names A's other condition by key.
   */
  async function buildWorld(label: string) {
    const newUser = async (suffix: string, name: string, role = 'user') => (await q<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash, role) VALUES ($1, $2, 'x', $3) RETURNING id`,
      [`${tag}${label}${suffix}@example.invalid`, name, role])).rows[0].id;
    const dm = await newUser('-dm', 'Fork DM');
    const a = await newUser('-a', 'Alice Library');
    const b = await newUser('-b', 'Bob Player');
    const admin = await newUser('-admin', 'Fork Admin', 'admin');
    const outsider = await newUser('-out', 'Fork Outsider');
    const c1 = (await q<{ id: string }>('INSERT INTO campaigns (name, invite_code, room_code) VALUES ($1, $2, $3) RETURNING id', [`${tag} ${label}`, code(10), code(8)])).rows[0].id;
    campaignIds.push(c1);
    for (const [userId, role] of [[dm, 'dm'], [a, 'player'], [b, 'player']]) {
      await q('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)', [c1, userId, role]);
    }
    await q('INSERT INTO campaign_library_settings (campaign_id, owner_user_id, is_enabled, updated_by_user_id) VALUES ($1, $2, true, $3)', [c1, a, dm]);

    const acModifier = (await q<{ id: string }>(`SELECT id FROM modifier_definitions WHERE target = 'ac' AND modifier_type = 'bonus' AND NOT is_archived ORDER BY created_at, id LIMIT 1`)).rows[0].id;
    const content = async (type: string, name: string, extra: { owner?: string; scope?: string; campaign?: string | null; archived?: boolean } = {}) => {
      const owner = extra.owner ?? a;
      const key = type === 'condition' ? `condition:library:${owner}:${name.toLowerCase()}:${hex()}` : `library:${owner}:${type}:${name.toLowerCase()}:${hex()}`;
      const id = (await q<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, scope, campaign_id, is_archived, metadata_json, stack_behavior)
         VALUES ($1, $2, $3, $4, 'homebrew', $5, $6, $7, $8, '{"isHomebrew": true}', 'stack') RETURNING id`,
        [key, type, `${tag} ${label} ${name}`, `${name} description`, extra.scope === 'campaign' ? dm : owner, extra.scope ?? 'personal', extra.campaign ?? null, extra.archived ?? false])).rows[0].id;
      if (type === 'item') await q('INSERT INTO item_definitions (content_id, ac_bonus, damage_rolls) VALUES ($1, 1, $2)', [id, '1d6']);
      if (type === 'spell') await q(`INSERT INTO spell_definitions (content_id, spell_level, school, base_dice, scaling_json) VALUES ($1, 2, 'Evocation', '2d6', '{"kind":"none"}')`, [id]);
      return { id, key };
    };
    const resource = async (contentId: string, key: string, max = '3') => (await q<{ id: string }>(
      `INSERT INTO content_resource_definitions (content_id, resource_key, label, max_value_expression, recharge_period) VALUES ($1, $2, $3, $4, 'long_rest') RETURNING id`,
      [contentId, key, `${key} label`, max])).rows[0].id;
    const link = (contentId: string, activation: string) => q(
      `INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, priority, sort_order) VALUES ($1, $2, $3, 0, 0)`, [contentId, acModifier, activation]);

    const sword = await content('item', 'Sword');
    const swordCharges = await resource(sword.id, 'charges');
    await link(sword.id, 'equipped');
    const featG = await content('feat', 'Grit');
    const featUses = await resource(featG.id, 'uses', '2');
    await link(featG.id, 'manual');
    await q(`INSERT INTO content_grants (source_content_id, granted_content_id, activation_type) VALUES ($1, $2, 'equipped')`, [sword.id, featG.id]);
    const cond1 = await content('condition', 'Dazzle');
    await link(cond1.id, 'manual');
    const cond2 = await content('condition', 'Burning');
    const action = await content('action', 'Swing');
    await q(`INSERT INTO content_action_links (content_id, action_container_id, trigger_type) VALUES ($1, $2, 'on_use')`, [sword.id, action.id]);
    await q(`INSERT INTO action_steps (container_id, step_type, operation, effect_container_id, label, sort_order) VALUES ($1, 'apply_effect', 'apply', $2, 'Dazzle', 0)`, [action.id, cond1.id]);
    const spellS = await content('spell', 'Zap');
    const wand = await content('item', 'Wand');
    const wandCharges = await resource(wand.id, 'wandcharges', '5');
    await q(`INSERT INTO content_spell_access (owner_content_id, spell_content_id, access_type, availability_type, resource_definition_id) VALUES ($1, $2, 'charges', 'equipped', $3)`, [wand.id, spellS.id, wandCharges]);
    const forageItem = await content('item', 'Herb');

    const rulesWith = (conditionKey: string) => ({
      version: 1, cards: [{ id: 'c1', label: 'Flash', tags: { kind: 'x' }, value: 3 }], success: { rules: [], otherwise: 'success' },
      outcomes: [{ id: 'o', when: {}, name: 'O', text: 't', steps: [{ type: 'condition', conditionKey, params: {}, durationRounds: 5, target: 'drawer' }] }]
    });
    const deck = async (name: string, rules: unknown, extra: { scope: 'personal' | 'campaign' }) => {
      const made = await content('deck', name, extra.scope === 'campaign' ? { scope: 'campaign', campaign: c1 } : {});
      await q('INSERT INTO deck_definitions (content_id, rules_json, campaign_id) VALUES ($1, $2::jsonb, $3)', [made.id, JSON.stringify(rules), extra.scope === 'campaign' ? c1 : null]);
      return made;
    };
    const deck1 = await deck('PersonalDeck', rulesWith(cond2.key), { scope: 'personal' });
    const cdeck = await deck('CampaignDeck', rulesWith(cond1.key), { scope: 'campaign' });
    await q('INSERT INTO campaign_decks (campaign_id, deck_content_id, is_enabled, added_by_user_id) VALUES ($1, $2, true, $4), ($1, $3, true, $4)', [c1, deck1.id, cdeck.id, dm]);
    const table = (await q<{ id: string }>(`INSERT INTO find_tables (name, area_type, category, campaign_id) VALUES ($1, $2, 'plant', $3) RETURNING id`, [`${tag} ${label} table`, `${tag}${label}`, c1])).rows[0].id;
    await q('INSERT INTO find_table_entries (find_table_id, item_id) VALUES ($1, $2)', [table, forageItem.id]);

    // Characters. B is in C1 and holds / knows / has on everything of A's. A's own character is in C1 holding the sword;
    // A's second character is in no campaign.
    const inCampaign = async (userId: string, name: string) => {
      const id = await characters.createCharacter(userId, name);
      await q('UPDATE characters SET campaign_id = $2, party_active = true WHERE id = $1', [id, c1]);
      return id;
    };
    const charB = await inCampaign(b, 'Bob the Bold');
    const charA = await inCampaign(a, 'Alice the Archer');
    const charA2 = await characters.createCharacter(a, 'Alice Two');
    const holdItem = async (characterId: string, item: { id: string }, name: string, resourceId: string | null) => {
      const row = (await q<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, equipped, location, quantity) VALUES ($1, $2, $3, true, 'equipped', 1) RETURNING id`,
        [characterId, name, item.id])).rows[0].id;
      if (resourceId) await q('INSERT INTO character_inventory_resources (inventory_item_id, resource_definition_id, current_value, max_value) VALUES ($1, $2, 1, 3)', [row, resourceId]);
      return row;
    };
    const bSword = await holdItem(charB, sword, 'Sword', swordCharges);
    const bWand = await holdItem(charB, wand, 'Wand', wandCharges);
    const aSword = await holdItem(charA, sword, 'Sword', swordCharges);
    const a2Sword = await holdItem(charA2, sword, 'Sword', swordCharges);
    const know = async (characterId: string, item: { id: string }) => (await q<{ id: string }>(
      `INSERT INTO character_content_instances (character_id, content_id, is_known, is_prepared, notes) VALUES ($1, $2, true, true, 'kept notes') RETURNING id`, [characterId, item.id])).rows[0].id;
    const bSpell = await know(charB, spellS);
    const bFeat = await know(charB, featG);
    await q('INSERT INTO character_content_resources (character_content_id, resource_definition_id, current_value, max_value) VALUES ($1, $2, 1, 2)', [bFeat, featUses]);
    const bEffect = (await q<{ id: string }>(`INSERT INTO active_character_effects (character_id, container_id, remaining_rounds) VALUES ($1, $2, 4) RETURNING id`, [charB, cond1.id])).rows[0].id;
    invalidateReferenceData('fork test');

    return {
      label, dm, a, b, admin, outsider, c1, charA, charA2, charB, bSword, bWand, aSword, a2Sword, bSpell, bFeat, bEffect, table,
      swordCharges, featUses, wandCharges, rulesWith,
      sword, featG, cond1, cond2, action, spellS, wand, forageItem, deck1, cdeck
    };
  }

  const copyOf = async (w: World, original: { id: string }) =>
    (await q<any>('SELECT * FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id = $2', [w.c1, original.id])).rows[0];
  const count = async (sql: string, params: unknown[] = []) => Number((await q<any>(sql, params)).rows[0].n);
  // What is in the tables a fork must never shrink (nothing is hard-deleted).
  const rowCounts = async (w: World) => ({
    content: await count('SELECT count(*) AS n FROM content_definitions WHERE scope = \'personal\' AND owner_user_id = $1', [w.a]),
    inventory: await count('SELECT count(*) AS n FROM character_inventory_items WHERE character_id = ANY($1::uuid[])', [[w.charA, w.charA2, w.charB]]),
    instances: await count('SELECT count(*) AS n FROM character_content_instances WHERE character_id = $1', [w.charB]),
    effects: await count('SELECT count(*) AS n FROM active_character_effects WHERE character_id = $1', [w.charB]),
    invResources: await count('SELECT count(*) AS n FROM character_inventory_resources WHERE inventory_item_id IN (SELECT id FROM character_inventory_items WHERE character_id = $1)', [w.charB]),
    contentResources: await count('SELECT count(*) AS n FROM character_content_resources WHERE character_content_id IN (SELECT id FROM character_content_instances WHERE character_id = $1)', [w.charB]),
    campaignDecks: await count('SELECT count(*) AS n FROM campaign_decks WHERE campaign_id = $1', [w.c1]),
    forage: await count('SELECT count(*) AS n FROM find_table_entries WHERE find_table_id = $1', [w.table]),
    members: await count('SELECT count(*) AS n FROM campaign_members WHERE campaign_id = $1', [w.c1])
  });
  // The resolved modifiers for a character, without the source ids (those change when a use moves to a copy).
  const resolved = async (characterId: string) => (await ruleEngine.resolveCharacterModifierSources(characterId)).audit
    .map((row) => `${row.sourceType}|${row.sourceName}|${row.target}|${row.operation}|${row.valueExpression}`).sort();

  // ------------------------------------------------------------------ leave

  it('forks on leave across every root type, never deletes, and a repeat changes nothing', async () => {
    const w = await buildWorld('leave');
    const beforeCounts = await rowCounts(w);
    const aRows = (await q<any>(`SELECT id, to_jsonb(c) AS row FROM content_definitions c WHERE scope = 'personal' AND owner_user_id = $1 ORDER BY id`, [w.a])).rows;
    const auditBefore = await resolved(w.charB);
    expect(auditBefore.length).toBeGreaterThan(0);
    // A snapshot of B taken before the fork, for the restore test below.
    const versionId = await withTransaction(async (client) => {
      await characters.createVersionWithClient(client, w.charB, w.b, 'before fork');
      return (await client.query('SELECT id FROM character_versions WHERE character_id = $1 ORDER BY created_at DESC LIMIT 1', [w.charB])).rows[0].id as string;
    });

    const left = await campaigns.leaveCampaign(w.a, w.c1);
    expect(left.fork.copies.length).toBeGreaterThanOrEqual(9);

    // Copies exist for every root and everything reachable from it.
    const copies: Record<string, any> = Object.fromEntries(await Promise.all(
      (['sword', 'featG', 'cond1', 'cond2', 'action', 'spellS', 'wand', 'forageItem', 'deck1'] as const).map(async (name) => [name, await copyOf(w, w[name])])));
    for (const [name, copy] of Object.entries(copies) as Array<[string, any]>) {
      expect(copy, name).toBeTruthy();
      expect(copy).toMatchObject({ scope: 'campaign', campaign_id: w.c1, owner_user_id: null, source_kind: 'homebrew' });
      expect(copy.metadata_json.fork).toMatchObject({ fromOwnerUserId: w.a, fromOwnerName: 'Alice Library', reason: 'left' });
    }
    // Key format: conditions keep the "condition:" prefix (snapshots and restore rely on it), the rest are fork:<campaign>:<original>.
    expect(copies.cond1.content_key).toBe(`condition:fork:${w.c1}:${w.cond1.id}`);
    expect(copies.sword.content_key).toBe(`fork:${w.c1}:${w.sword.id}`);
    // The cdeck (campaign-authored) is not a copy; it was re-pointed instead.
    expect(await copyOf(w, w.cdeck)).toBeUndefined();

    // Every use in C1 points at a copy. B's inventory, charges kept (current 1 of 3), same row ids.
    const bSword = (await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0];
    expect(bSword.source_content_id).toBe(copies.sword.id);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bWand])).rows[0].source_content_id).toBe(copies.wand.id);
    const bCharges = (await q<any>(
      `SELECT r.current_value, r.max_value, d.content_id, d.resource_key FROM character_inventory_resources r JOIN content_resource_definitions d ON d.id = r.resource_definition_id WHERE r.inventory_item_id = $1`, [w.bSword])).rows;
    expect(bCharges).toEqual([{ current_value: 1, max_value: 3, content_id: copies.sword.id, resource_key: 'charges' }]);
    // Known spell and feat: same instance ids, notes, preparation, and counters (with the copy's definition).
    const instances = (await q<any>('SELECT id, content_id, notes, is_prepared FROM character_content_instances WHERE character_id = $1', [w.charB])).rows;
    expect(instances.find((row) => row.id === w.bSpell)).toMatchObject({ content_id: copies.spellS.id, notes: 'kept notes', is_prepared: true });
    expect(instances.find((row) => row.id === w.bFeat)).toMatchObject({ content_id: copies.featG.id });
    const featCounter = (await q<any>(`SELECT r.current_value, r.max_value, d.content_id FROM character_content_resources r JOIN content_resource_definitions d ON d.id = r.resource_definition_id WHERE r.character_content_id = $1`, [w.bFeat])).rows;
    expect(featCounter).toEqual([{ current_value: 1, max_value: 2, content_id: copies.featG.id }]);
    // The applied condition keeps its row id (a deck draw's undo finds it) and points at the copy.
    expect((await q<any>('SELECT container_id, remaining_rounds FROM active_character_effects WHERE id = $1', [w.bEffect])).rows[0]).toEqual({ container_id: copies.cond1.id, remaining_rounds: 4 });
    // Enabled deck and forage entry.
    expect((await q<any>('SELECT deck_content_id, is_enabled FROM campaign_decks WHERE campaign_id = $1 AND deck_content_id = $2', [w.c1, copies.deck1.id])).rows).toEqual([{ deck_content_id: copies.deck1.id, is_enabled: true }]);
    expect(await count('SELECT count(*) AS n FROM campaign_decks WHERE campaign_id = $1 AND deck_content_id = $2', [w.c1, w.deck1.id])).toBe(0);
    expect((await q<any>('SELECT item_id FROM find_table_entries WHERE find_table_id = $1', [w.table])).rows).toEqual([{ item_id: copies.forageItem.id }]);

    // Closure: the sword's grant, action (with its step), the wand's spell access, modifier links and resource keys.
    expect((await q<any>('SELECT granted_content_id FROM content_grants WHERE source_content_id = $1', [copies.sword.id])).rows).toEqual([{ granted_content_id: copies.featG.id }]);
    expect(await count('SELECT count(*) AS n FROM content_action_links WHERE content_id = $1 AND action_container_id = $2', [copies.sword.id, copies.action.id])).toBe(1);
    expect((await q<any>('SELECT effect_container_id, step_type FROM action_steps WHERE container_id = $1', [copies.action.id])).rows).toEqual([{ effect_container_id: copies.cond1.id, step_type: 'apply_effect' }]);
    const access = (await q<any>('SELECT a.spell_content_id, d.content_id, d.resource_key FROM content_spell_access a JOIN content_resource_definitions d ON d.id = a.resource_definition_id WHERE a.owner_content_id = $1', [copies.wand.id])).rows;
    expect(access).toEqual([{ spell_content_id: copies.spellS.id, content_id: copies.wand.id, resource_key: 'wandcharges' }]);
    expect(await count('SELECT count(*) AS n FROM content_modifier_links WHERE content_id = $1', [copies.sword.id])).toBe(1);
    // Item and spell rows are copied column for column (a column added later but not copied would show up here).
    for (const [orig, copy, table] of [[w.sword, copies.sword, 'item_definitions'], [w.spellS, copies.spellS, 'spell_definitions']] as const) {
      const row = async (id: string) => { const r = (await q<any>(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE content_id = $1`, [id])).rows[0].row; delete r.content_id; return r; };
      expect(await row(copy.id)).toEqual(await row(orig.id));
    }
    // A condition copy keeps the duration fields too (every other content column is copied).
    for (const [orig, copy] of [[w.cond1, copies.cond1], [w.sword, copies.sword]] as const) {
      const row = async (id: string) => { const r = (await q<any>('SELECT to_jsonb(c) AS row FROM content_definitions c WHERE id = $1', [id])).rows[0].row; for (const k of ['id', 'content_key', 'owner_user_id', 'scope', 'campaign_id', 'forked_from_content_id', 'metadata_json', 'created_at', 'updated_at']) delete r[k]; return r; };
      expect(await row(copy.id)).toEqual(await row(orig.id));
    }

    // Deck rules: the personal deck's copy and the campaign-authored deck both name the copied conditions now.
    const rulesOf = async (id: string) => JSON.stringify((await q<any>('SELECT rules_json FROM deck_definitions WHERE content_id = $1', [id])).rows[0].rules_json);
    expect(await rulesOf(copies.deck1.id)).toContain(copies.cond2.content_key);
    expect(await rulesOf(copies.deck1.id)).not.toContain(w.cond2.key);
    expect(await rulesOf(w.cdeck.id)).toContain(copies.cond1.content_key);
    expect(await rulesOf(w.cdeck.id)).not.toContain(w.cond1.key);
    expect((await q<any>('SELECT campaign_id FROM deck_definitions WHERE content_id = $1', [copies.deck1.id])).rows[0].campaign_id).toBe(w.c1); // the mirror

    // A drawn card applies the COPIED condition (the draw rule reads the campaign's own condition).
    const effectsOn = () => count('SELECT count(*) AS n FROM active_character_effects WHERE character_id = $1 AND container_id = $2', [w.charB, copies.cond1.id]);
    const heldBefore = await effectsOn();
    const draw = await decks.drawCard({ userId: w.b, characterId: w.charB, deckId: w.cdeck.id, deps: { cardId: 'c1' } });
    expect(draw.draw.dmTasks).toEqual([]);
    expect(await effectsOn()).toBe(heldBefore + 1);

    // B's resolved modifiers are unchanged (the same names and numbers, now from the copies).
    await q('DELETE FROM active_character_effects WHERE character_id = $1 AND id <> $2', [w.charB, w.bEffect]);
    expect(await resolved(w.charB)).toEqual(auditBefore);

    // A's library and A's released characters are untouched; nothing was deleted anywhere.
    const aRowsAfter = (await q<any>(`SELECT id, to_jsonb(c) AS row FROM content_definitions c WHERE scope = 'personal' AND owner_user_id = $1 ORDER BY id`, [w.a])).rows;
    expect(aRowsAfter).toEqual(aRows);
    expect((await q<any>('SELECT campaign_id FROM characters WHERE id = $1', [w.charA])).rows[0].campaign_id).toBeNull();
    for (const row of [w.aSword, w.a2Sword]) {
      expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [row])).rows[0].source_content_id).toBe(w.sword.id);
    }
    const afterCounts = await rowCounts(w);
    expect({ ...afterCounts, members: 0 }).toEqual({ ...beforeCounts, members: 0 });
    expect(afterCounts.members).toBe(beforeCounts.members - 1);
    expect(await count('SELECT count(*) AS n FROM campaign_library_settings WHERE campaign_id = $1 AND owner_user_id = $2', [w.c1, w.a])).toBe(1); // the row stays for a rejoin

    // ---- idempotent: the repair entry point and a direct re-run find nothing left to do
    const totals = async () => ({
      content: await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1', [w.c1]),
      steps: await count('SELECT count(*) AS n FROM action_steps WHERE container_id IN (SELECT id FROM content_definitions WHERE campaign_id = $1)', [w.c1]),
      grants: await count('SELECT count(*) AS n FROM content_grants WHERE source_content_id IN (SELECT id FROM content_definitions WHERE campaign_id = $1)', [w.c1])
    });
    const totalsBefore = await totals();
    const repaired = await withTransaction((client) => libraryFork.forkFormerMembersContent(client, w.c1, { actorUserId: w.dm }));
    expect(repaired).toEqual([]);
    const again = await withTransaction((client) => libraryFork.forkLibraryContent(client, w.c1, w.a, { reason: 'repair', actorUserId: w.dm }));
    expect(again.copies).toEqual([]);
    expect(again.repointed).toEqual({});
    expect(await totals()).toEqual(totalsBefore);

    // ---- the stale sheet: B's sheet was open before the fork and still lists the ORIGINAL ids and keys
    const staleForm = (swordQuantity: string, baseline?: string) => {
      const form = new FormData();
      form.set('name', 'Bob the Bold');
      if (baseline) form.set('inventoryBaseline', baseline);
      for (const [id, name, source, qty] of [[w.bSword, 'Sword', w.sword.id, swordQuantity], [w.bWand, 'Wand', w.wand.id, '1']]) {
        form.append('inventoryId', id); form.append('inventoryName', name); form.append('inventorySourceContentId', source);
        form.append('inventoryQuantity', qty); form.append('inventoryLocation', 'equipped'); form.append('inventoryEquipped', 'true');
      }
      form.append('activeEffectKey', w.cond1.key.replace(/^condition:/, ''));
      return form;
    };
    await characters.updateCharacter(w.b, w.charB, staleForm('1'), 'stale save'); // no baseline: the old full replace
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0].source_content_id).toBe(copies.sword.id);
    const baseline = JSON.stringify([{ id: w.bSword, name: 'Sword', quantity: 1, category: 'gear', location: 'equipped', equipped: true, sourceContentId: w.sword.id, proficient: true, attackAbility: 'str', abilityBonuses: {} }]);
    await characters.updateCharacter(w.b, w.charB, staleForm('2', baseline), 'stale save with baseline');
    // The edited row is written (the user's change wins) but the re-pointed source stays.
    expect((await q<any>('SELECT source_content_id, quantity FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0]).toEqual({ source_content_id: copies.sword.id, quantity: 2 });
    // The stale condition key leaves the re-pointed copy on B, and does not add the original beside it.
    expect(await count('SELECT count(*) AS n FROM active_character_effects WHERE character_id = $1 AND container_id = $2', [w.charB, w.cond1.id])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM active_character_effects WHERE character_id = $1 AND container_id = $2', [w.charB, copies.cond1.id])).toBeGreaterThanOrEqual(1);

    // ---- snapshot restore. The snapshot (taken before the fork) holds ORIGINAL ids and keys.
    await q('DELETE FROM character_inventory_items WHERE id = ANY($1::uuid[])', [[w.bSword, w.bWand]]); // so the restore has to INSERT them
    await characters.restoreCharacterVersion(w.b, w.charB, versionId);
    const restoredSword = (await q<any>('SELECT id, source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0];
    expect(restoredSword.source_content_id).toBe(copies.sword.id); // mapped to the copy
    expect((await q<any>(`SELECT d.content_id FROM character_inventory_resources r JOIN content_resource_definitions d ON d.id = r.resource_definition_id WHERE r.inventory_item_id = $1`, [w.bSword])).rows)
      .toEqual([{ content_id: copies.sword.id }]);
    const restoredInstances = (await q<any>('SELECT content_id FROM character_content_instances WHERE character_id = $1', [w.charB])).rows.map((row) => row.content_id).sort();
    expect(restoredInstances).toEqual([copies.spellS.id, copies.featG.id].sort());
    expect((await q<any>(`SELECT d.content_id FROM character_content_resources r JOIN content_resource_definitions d ON d.id = r.resource_definition_id
      WHERE r.character_content_id IN (SELECT id FROM character_content_instances WHERE character_id = $1)`, [w.charB])).rows).toEqual([{ content_id: copies.featG.id }]);
    expect((await q<any>('SELECT container_id FROM active_character_effects WHERE character_id = $1', [w.charB])).rows).toEqual([{ container_id: copies.cond1.id }]);

    // Restored after B has left C1, the same snapshot uses A's originals, which still resolve.
    await q('UPDATE characters SET campaign_id = NULL WHERE id = $1', [w.charB]);
    await q('DELETE FROM character_inventory_items WHERE id = ANY($1::uuid[])', [[w.bSword, w.bWand]]);
    await characters.restoreCharacterVersion(w.b, w.charB, versionId);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0].source_content_id).toBe(w.sword.id);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bWand])).rows[0].source_content_id).toBe(w.wand.id);
    expect((await q<any>('SELECT container_id FROM active_character_effects WHERE character_id = $1', [w.charB])).rows).toEqual([{ container_id: w.cond1.id }]);
  }, 120_000);

  it('reuses existing copies when a member rejoins and leaves again, and DM edits to a copy survive', async () => {
    const w = await buildWorld('rejoin');
    await campaigns.leaveCampaign(w.a, w.c1);
    const swordCopy = await copyOf(w, w.sword);
    // The DM edits the copy on the campaign copies page.
    await homebrew.updateCampaignEntry(w.dm, w.c1, fd({ contentId: swordCopy.id, name: `${tag} DM renamed sword`, description: 'DM wrote this', acBonus: '3', category: 'weapon', equipmentType: 'item' }));
    const edited = (await q<any>('SELECT c.name, c.description, i.ac_bonus FROM content_definitions c JOIN item_definitions i ON i.content_id = c.id WHERE c.id = $1', [swordCopy.id])).rows[0];
    expect(edited).toMatchObject({ name: `${tag} DM renamed sword`, description: 'DM wrote this', ac_bonus: 3 });

    // A rejoins, and A's character and B each pick up the library original again.
    await q('INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1, $2, $3)', [w.c1, w.a, 'player']);
    await q('UPDATE characters SET campaign_id = $2 WHERE id = $1', [w.charA, w.c1]);
    const newRow = (await q<{ id: string }>(`INSERT INTO character_inventory_items (character_id, name, source_content_id) VALUES ($1, 'Second sword', $2) RETURNING id`, [w.charB, w.sword.id])).rows[0].id;
    const copiesBefore = await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1', [w.c1]);

    const second = await campaigns.leaveCampaign(w.a, w.c1);
    expect(second.fork.copies).toEqual([]); // everything already had a copy
    expect(second.fork.reused).toBeGreaterThan(0);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1', [w.c1])).toBe(copiesBefore);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [newRow])).rows[0].source_content_id).toBe(swordCopy.id); // moved onto the existing copy
    const after = (await q<any>('SELECT c.id, c.name, c.description, i.ac_bonus FROM content_definitions c JOIN item_definitions i ON i.content_id = c.id WHERE c.id = $1', [swordCopy.id])).rows[0];
    expect(after).toEqual({ id: swordCopy.id, ...edited }); // the DM's edits are still there, same copy row
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id = $2', [w.c1, w.sword.id])).toBe(1);
  }, 120_000);

  it('repairs a member who left before the fork existed, then finds nothing more to do', async () => {
    const w = await buildWorld('repair');
    // Simulate the old leave: membership gone and the leaver's character released, nothing forked.
    await q('UPDATE characters SET campaign_id = NULL WHERE owner_user_id = $1', [w.a]);
    await q('DELETE FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [w.c1, w.a]);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL', [w.c1])).toBe(0);
    const dry = await withTransaction(async (client) => {
      const result = await libraryFork.forkFormerMembersContent(client, w.c1, { dryRun: true });
      return result;
    });
    expect(dry).toHaveLength(1);
    expect(dry[0].dryRun).toBe(true);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL', [w.c1])).toBe(0); // a dry run writes nothing
    const first = await withTransaction((client) => libraryFork.forkFormerMembersContent(client, w.c1, { actorUserId: w.dm }));
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ ownerUserId: w.a, reason: 'repair' });
    expect((await copyOf(w, w.sword)).metadata_json.fork.reason).toBe('repair');
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0].source_content_id).toBe((await copyOf(w, w.sword)).id);
    const totalCopies = await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL', [w.c1]);
    expect(await withTransaction((client) => libraryFork.forkFormerMembersContent(client, w.c1))).toEqual([]);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL', [w.c1])).toBe(totalCopies);
  }, 120_000);

  it('rolls the whole leave back when the fork fails, with a clear message', async () => {
    const w = await buildWorld('fail');
    // A trigger that fails only when this campaign's enabled decks are re-pointed: late in the fork, after the copies exist.
    await q(`CREATE OR REPLACE FUNCTION ${tag}_fail() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'forced fork failure'; END $$ LANGUAGE plpgsql`);
    const name = `${tag}_fail_${w.label}`;
    triggers.push(name);
    await q(`CREATE TRIGGER ${name} BEFORE UPDATE ON campaign_decks FOR EACH ROW WHEN (OLD.campaign_id = '${w.c1}') EXECUTE FUNCTION ${tag}_fail()`);
    const before = await rowCounts(w);
    await expect(campaigns.leaveCampaign(w.a, w.c1)).rejects.toThrow("Couldn't keep copies of Alice Library's homebrew for this campaign. Nothing was changed.");
    expect(await rowCounts(w)).toEqual(before);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL', [w.c1])).toBe(0);
    expect((await q<any>('SELECT campaign_id FROM characters WHERE id = $1', [w.charA])).rows[0].campaign_id).toBe(w.c1); // A is still in, with their character
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0].source_content_id).toBe(w.sword.id);
    // The DM removing A fails the same way, and so does the manual button.
    await expect(campaigns.removeMember(w.dm, w.c1, w.a)).rejects.toThrow('Nothing was changed.');
    await expect(campaigns.keepCampaignCopy(w.dm, w.c1, w.a)).rejects.toThrow('Nothing was changed.');
    expect(await count('SELECT count(*) AS n FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [w.c1, w.a])).toBe(1);
    // With the fault gone it works.
    await q(`DROP TRIGGER ${name} ON campaign_decks`);
    await campaigns.removeMember(w.dm, w.c1, w.a);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL', [w.c1])).toBeGreaterThan(0);
  }, 120_000);

  it('admin undo of a find made before a fork still reaches the row, now holding the campaign copy', async () => {
    const w = await buildWorld('undo');
    // B's sword row stands in for the row a find wrote to (quantity 1, the find added 1), then A leaves and the row moves to the copy.
    const find = (await q<{ id: string }>(
      `INSERT INTO finds (mode, status, character_id, finder_user_id, find_table_id, campaign_id, results, resolved_at)
       VALUES ('dm', 'found', $1, $2, $3, $4, $5::jsonb, now()) RETURNING id`,
      [w.charB, w.b, w.table, w.c1, JSON.stringify([
        { item_id: w.sword.id, qty: 1, inventory_id: w.bSword },
        { item_id: w.wand.id, qty: 1, inventory_id: w.bWand }
      ])])).rows[0].id;
    await campaigns.leaveCampaign(w.a, w.c1);
    const swordCopy = await copyOf(w, w.sword);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0].source_content_id).toBe(swordCopy.id);
    // The player has since swapped the wand row to something unrelated: that one must still be left alone.
    await q('UPDATE character_inventory_items SET source_content_id = $2 WHERE id = $1', [w.bWand, w.forageItem.id]);

    const reverted = await forage.revertFind({ findId: find, adminUserId: w.admin });
    expect(reverted!.note).toContain('Sword: removed');
    expect(reverted!.note).toContain('Wand: the row now holds a different item, left alone');
    expect(await count('SELECT count(*) AS n FROM character_inventory_items WHERE id = $1', [w.bSword])).toBe(0);
    expect(await count('SELECT count(*) AS n FROM character_inventory_items WHERE id = $1', [w.bWand])).toBe(1);
  }, 60_000);

  // ------------------------------------------------------------------ switch-off and the manual button

  it('does not fork when the DM switches a library off, and the uses keep working', async () => {
    const w = await buildWorld('off');
    await library.setCampaignLibrary(w.dm, w.c1, w.a, false);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL', [w.c1])).toBe(0);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0].source_content_id).toBe(w.sword.id);
    expect(await resolved(w.charB)).not.toEqual([]); // still resolves from the original
  }, 60_000);

  it('Keep a campaign copy: re-points everyone including the owner, the library stays on, and a second press reuses the copy', async () => {
    const w = await buildWorld('keep');
    const settingBefore = (await q<any>('SELECT * FROM campaign_library_settings WHERE campaign_id = $1 AND owner_user_id = $2', [w.c1, w.a])).rows[0];
    const usesBefore = await libraryFork.countLibraryUsesInCampaign({ query: q }, w.c1, w.a);
    expect(usesBefore).toBeGreaterThan(5);
    expect((await library.loadCampaignLibraryPage({ query: q }, w.dm, w.c1))!.members.find((m) => m.userId === w.a)!.uses).toBe(usesBefore);
    expect((await library.loadCampaignLibraryPage({ query: q }, w.b, w.c1))!.members.find((m) => m.userId === w.a)!.uses).toBeNull(); // managers only

    const pressed = await campaigns.keepCampaignCopy(w.dm, w.c1, w.a);
    expect(pressed.fork.reason).toBe('manual');
    const swordCopy = await copyOf(w, w.sword);
    expect(swordCopy.metadata_json.fork.reason).toBe('manual');
    // A is still a member, and A's OWN character in C1 was re-pointed too, along with B's.
    expect(await count('SELECT count(*) AS n FROM campaign_members WHERE campaign_id = $1 AND user_id = $2', [w.c1, w.a])).toBe(1);
    for (const row of [w.aSword, w.bSword]) {
      expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [row])).rows[0].source_content_id).toBe(swordCopy.id);
    }
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.a2Sword])).rows[0].source_content_id).toBe(w.sword.id); // A's character outside C1
    expect(await libraryFork.countLibraryUsesInCampaign({ query: q }, w.c1, w.a)).toBe(0);
    // The setting row is exactly as it was (the library is still on).
    expect((await q<any>('SELECT * FROM campaign_library_settings WHERE campaign_id = $1 AND owner_user_id = $2', [w.c1, w.a])).rows[0]).toEqual(settingBefore);

    // A edits and archives the original: the campaign's uses do not move.
    await q(`UPDATE content_definitions SET name = $2, description = 'A changed it', is_archived = true WHERE id = $1`, [w.sword.id, `${tag} A edited sword`]);
    invalidateReferenceData('fork test');
    const copyNow = (await q<any>('SELECT name, is_archived FROM content_definitions WHERE id = $1', [swordCopy.id])).rows[0];
    expect(copyNow).toEqual({ name: `${tag} keep Sword`, is_archived: false });
    expect(await resolved(w.charB)).not.toEqual([]);
    await q('UPDATE content_definitions SET is_archived = false WHERE id = $1', [w.sword.id]);
    invalidateReferenceData('fork test');

    // The library is still on, so the picker offers BOTH, labelled differently.
    const scope = await library.resolveVisibleScope({ query: q }, w.b, { characterId: w.charB });
    const offered = await catalogue.listCatalogue(w.b, 'item', tag, scope);
    const original = offered.find((entry) => entry.id === w.sword.id);
    const copy = offered.find((entry) => entry.id === swordCopy.id);
    expect(original && copy).toBeTruthy();
    const { catalogueSourceLabel } = await import('$lib/library/rules');
    const label = (entry: any) => catalogueSourceLabel({ sourceKind: entry.sourceKind, scope: entry.scope, ownerName: entry.ownerName, forkedFromOwnerName: entry.forkedFromOwnerName });
    expect(label(original)).toBe("Alice Library's homebrew");
    expect(label(copy)).toBe("Campaign copy (from Alice Library's library)");
    await catalogue.addContentToCharacter(w.b, w.charB, swordCopy.id); // and the copy can really be added

    // B adds the original again. A second press moves that use onto the EXISTING copy (no second copy), keeping the DM's edits.
    await homebrew.updateCampaignEntry(w.dm, w.c1, fd({ contentId: swordCopy.id, name: `${tag} DM edit after keep`, description: 'DM text' }));
    const again = (await q<{ id: string }>(`INSERT INTO character_inventory_items (character_id, name, source_content_id) VALUES ($1, 'Fresh sword', $2) RETURNING id`, [w.charB, w.sword.id])).rows[0].id;
    expect(await libraryFork.countLibraryUsesInCampaign({ query: q }, w.c1, w.a)).toBe(1);
    const second = await campaigns.keepCampaignCopy(w.dm, w.c1, w.a);
    expect(second.fork.copies).toEqual([]);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [again])).rows[0].source_content_id).toBe(swordCopy.id);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id = $2', [w.c1, w.sword.id])).toBe(1);
    expect((await q<any>('SELECT name, description FROM content_definitions WHERE id = $1', [swordCopy.id])).rows[0]).toEqual({ name: `${tag} DM edit after keep`, description: 'DM text' });
    expect((await q<any>('SELECT * FROM campaign_library_settings WHERE campaign_id = $1 AND owner_user_id = $2', [w.c1, w.a])).rows[0]).toEqual(settingBefore);
  }, 120_000);

  it('Keep a campaign copy with the library off: the copies cover everything and nothing new picks the original', async () => {
    const w = await buildWorld('keepoff');
    await library.setCampaignLibrary(w.dm, w.c1, w.a, false);
    await campaigns.keepCampaignCopy(w.dm, w.c1, w.a);
    const swordCopy = await copyOf(w, w.sword);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0].source_content_id).toBe(swordCopy.id);
    expect((await q<any>('SELECT is_enabled FROM campaign_library_settings WHERE campaign_id = $1 AND owner_user_id = $2', [w.c1, w.a])).rows[0].is_enabled).toBe(false);
    const scope = await library.resolveVisibleScope({ query: q }, w.b, { characterId: w.charB });
    const offered = (await catalogue.listCatalogue(w.b, 'item', tag, scope)).map((entry) => entry.id);
    expect(offered).toContain(swordCopy.id);
    expect(offered).not.toContain(w.sword.id);
    await expect(catalogue.addContentToCharacter(w.b, w.charB, w.sword.id)).rejects.toThrow('Catalogue entry not found.');
    // The campaign's picker also offers the copies of conditions and decks to the campaign's own rules.
    const cond1Copy = await copyOf(w, w.cond1);
    await library.assertReferenceAllowed({ query: q }, swordCopy.id, cond1Copy.id);
  }, 120_000);

  it('Keep a campaign copy: only a DM, only a live campaign, only a current member', async () => {
    const w = await buildWorld('perm');
    await expect(campaigns.keepCampaignCopy(w.b, w.c1, w.a)).rejects.toThrow("You can't manage this campaign.");
    await expect(campaigns.keepCampaignCopy(w.outsider, w.c1, w.a)).rejects.toThrow("You can't manage this campaign.");
    await expect(campaigns.keepCampaignCopy(w.dm, w.c1, w.outsider)).rejects.toThrow('not a member');
    await expect(campaigns.keepCampaignCopy(w.dm, w.c1, 'not-a-uuid')).rejects.toThrow('not a member');
    expect((await campaigns.keepCampaignCopy(w.admin, w.c1, w.a)).fork.copies.length).toBeGreaterThan(0); // the site-admin override
    await q('UPDATE campaigns SET is_archived = true WHERE id = $1', [w.c1]);
    await expect(campaigns.keepCampaignCopy(w.admin, w.c1, w.a)).rejects.toThrow('archived'); // only an admin can even reach an archived campaign
    await expect(campaigns.keepCampaignCopy(w.dm, w.c1, w.a)).rejects.toThrow("You can't manage this campaign.");
    await q('UPDATE campaigns SET is_archived = false WHERE id = $1', [w.c1]);
    expect(await count('SELECT count(*) AS n FROM content_definitions WHERE campaign_id = $1 AND forked_from_content_id IS NOT NULL', [w.c1])).toBeGreaterThan(0);
  }, 60_000);

  // ------------------------------------------------------------------ the copies page

  it('the campaign copies page: DM-only, edit and archive, never create, nothing across campaigns', async () => {
    const w = await buildWorld('page');
    await campaigns.keepCampaignCopy(w.dm, w.c1, w.a);
    const swordCopy = await copyOf(w, w.sword);
    const cond1Copy = await copyOf(w, w.cond1);

    // Who can load it.
    expect((await homebrew.loadCampaignHomebrew(w.b, w.c1, 'item', '')).status).toBe('forbidden');
    expect((await homebrew.loadCampaignHomebrew(w.outsider, w.c1, 'item', '')).status).toBe('missing');
    expect((await homebrew.loadCampaignHomebrew(w.dm, 'not-a-uuid', 'item', '')).status).toBe('missing');
    const asAdmin = await homebrew.loadCampaignHomebrew(w.admin, w.c1, 'item', '');
    expect(asAdmin.status).toBe('ok');
    const dmPage: any = (await homebrew.loadCampaignHomebrew(w.dm, w.c1, 'item', swordCopy.id) as any).data;
    expect(dmPage.content.map((entry: any) => entry.id).sort()).toEqual([swordCopy.id, (await copyOf(w, w.wand)).id, (await copyOf(w, w.forageItem)).id].sort());
    expect(dmPage.selectedContentId).toBe(swordCopy.id);
    expect(dmPage.forks[swordCopy.id]).toMatchObject({ fromOwnerName: 'Alice Library', reason: 'manual' });
    // Not the original, and nothing of another campaign.
    expect(dmPage.content.map((entry: any) => entry.id)).not.toContain(w.sword.id);
    const conditionPage: any = (await homebrew.loadCampaignHomebrew(w.dm, w.c1, 'condition', '') as any).data;
    expect(conditionPage.conditions.map((entry: any) => entry.id).sort()).toEqual([cond1Copy.id, (await copyOf(w, w.cond2)).id].sort());

    // Editing and archiving a copy.
    await homebrew.updateCampaignEntry(w.dm, w.c1, fd({ contentId: swordCopy.id, name: `${tag} page sword`, description: 'edited', acBonus: '4', category: 'weapon', equipmentType: 'item' }));
    expect((await q<any>('SELECT name FROM content_definitions WHERE id = $1', [swordCopy.id])).rows[0].name).toBe(`${tag} page sword`);
    await homebrew.toggleCampaignEntryArchive(w.dm, w.c1, fd({ contentId: swordCopy.id }));
    expect((await q<any>('SELECT is_archived FROM content_definitions WHERE id = $1', [swordCopy.id])).rows[0].is_archived).toBe(true);
    expect((await q<any>('SELECT source_content_id FROM character_inventory_items WHERE id = $1', [w.bSword])).rows[0].source_content_id).toBe(swordCopy.id); // still held
    await homebrew.toggleCampaignEntryArchive(w.dm, w.c1, fd({ contentId: swordCopy.id }));
    await homebrew.saveCampaignCondition(w.dm, w.c1, fd({ effectId: cond1Copy.id, name: `${tag} Dazzle copy`, description: 'dm', durationType: 'timed', durationRounds: '2', stackBehavior: 'stack', sourceType: 'homebrew' }));
    expect((await q<any>('SELECT name, duration_rounds, metadata_json FROM content_definitions WHERE id = $1', [cond1Copy.id])).rows[0]).toMatchObject({ name: `${tag} Dazzle copy`, duration_rounds: 2 });
    expect((await q<any>('SELECT metadata_json->\'fork\'->>\'fromOwnerName\' AS who FROM content_definitions WHERE id = $1', [cond1Copy.id])).rows[0].who).toBe('Alice Library'); // saving keeps the fork note

    // Refused: a player, an original (personal) entry, another campaign's copy, a wrong type.
    await expect(homebrew.updateCampaignEntry(w.b, w.c1, fd({ contentId: swordCopy.id, name: 'x' }))).rejects.toThrow('Campaign not found.');
    await expect(homebrew.updateCampaignEntry(w.dm, w.c1, fd({ contentId: w.sword.id, name: 'x' }))).rejects.toThrow('Campaign entry not found.');
    await expect(homebrew.toggleCampaignEntryArchive(w.dm, w.c1, fd({ contentId: w.sword.id }))).rejects.toThrow('Campaign entry not found.');
    const w2 = await buildWorld('page2');
    await campaigns.keepCampaignCopy(w2.dm, w2.c1, w2.a);
    const otherCopy = await copyOf(w2, w2.sword);
    await expect(homebrew.updateCampaignEntry(w.dm, w.c1, fd({ contentId: otherCopy.id, name: 'x' }))).rejects.toThrow('Campaign entry not found.');
    await expect(homebrew.saveCampaignCondition(w.dm, w.c1, fd({ effectId: swordCopy.id, name: 'x' }))).rejects.toThrow('Campaign entry not found.');
    // Attachments follow the campaign reference rule: a campaign copy may name this campaign's condition copy, never another campaign's.
    await homebrew.campaignAttachEffect(w.dm, w.c1, fd({ contentId: swordCopy.id, effectId: cond1Copy.id, activationType: 'equipped' }));
    await expect(homebrew.campaignAttachEffect(w.dm, w.c1, fd({ contentId: swordCopy.id, effectId: (await copyOf(w2, w2.cond1)).id, activationType: 'equipped' }))).rejects.toThrow('cannot be used here');
    // A DM can add mechanics (a modifier) to a copy, which a player-authored entry could not.
    const modifier = (await q<any>(`SELECT id FROM modifier_definitions WHERE target = 'ac' AND NOT is_archived ORDER BY created_at, id LIMIT 1`)).rows[0].id;
    await homebrew.campaignAttachModifier(w.dm, w.c1, fd({ contentId: swordCopy.id, modifierId: modifier, activationType: 'carried' }));
    await expect(homebrew.campaignAttachModifier(w.b, w.c1, fd({ contentId: swordCopy.id, modifierId: modifier }))).rejects.toThrow('Campaign not found.');
  }, 120_000);
});
