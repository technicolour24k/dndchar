import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of the cost engine's character pools (cost engine Unit 2). SKIPPED unless
// COST_DB_TEST=1. Local DB only (guarded below). Creates a throwaway user + character + content and
// removes them at the end.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   COST_DB_TEST=1 npx vitest run src/lib/server/costEngine.integration.test.ts
const enabled = process.env.COST_DB_TEST === '1';

describe.skipIf(!enabled)('character resource pools', () => {
  it('sums maxima, ledgers adjustments, survives Save, refills on rest and round-trips snapshots', async () => {
    // Guard FIRST, before any query: local database only, and no ?host= override.
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query } = await import('$lib/server/db');
    const { createCharacter, getCharacter, updateCharacter, restoreCharacterVersion } = await import('./services/characters');
    const { adjustCharacterPool } = await import('./services/resource-pools');
    const { restCharacter } = await import('./services/catalogue');
    const tag = `zzcost${crypto.randomBytes(4).toString('hex')}`;
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Cost', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    const contentIds: string[] = [];
    try {
      const characterId = await createCharacter(userId, 'Pools');
      const modifierId = (await query<{ id: string }>(
        `SELECT id FROM modifier_definitions WHERE target='resource.vowfire.max' AND modifier_type='bonus' AND NOT is_archived LIMIT 1`)).rows[0]?.id;
      expect(modifierId, 'migration 044 seeds the Vowfire (max) modifier').toBeTruthy();
      const content = async (type: string, suffix: string) => {
        const id = (await query<{ id: string }>(
          `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1, $2, $3) RETURNING id`, [`${type}:${tag}${suffix}`, type, `IT ${suffix}`])).rows[0].id;
        contentIds.push(id);
        return id;
      };
      const link = (contentId: string, activation: string, value: string) => query(
        `INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, value_override_expression) VALUES ($1,$2,$3,$4)`, [contentId, modifierId, activation, value]);
      const feat = await content('feat', 'feat');
      await link(feat, 'known', '2');
      const ring = await content('item', 'ring');
      await link(ring, 'equipped', '1');
      await query(`INSERT INTO character_content_instances (character_id, content_id) VALUES ($1,$2)`, [characterId, feat]);
      const itemId = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, equipped) VALUES ($1,'IT Ring',$2,true) RETURNING id`, [characterId, ring])).rows[0].id;
      const vowfire = async () => (await getCharacter(userId, characterId))!.pools.find((p) => p.key === 'vowfire');

      // 2 (feat) + 1 (equipped ring) = 3, full with no row; unequipping drops it to 2.
      expect(await vowfire()).toMatchObject({ current: 3, max: 3 });
      expect((await vowfire())!.breakdown.map((l) => l.label)).toEqual(['Base', 'IT feat', 'IT Ring']);
      await query(`UPDATE character_inventory_items SET equipped=false WHERE id=$1`, [itemId]);
      expect(await vowfire()).toMatchObject({ current: 2, max: 2 });
      await query(`UPDATE character_inventory_items SET equipped=true WHERE id=$1`, [itemId]);
      // Soulfire has no source: max 0 and hidden.
      expect((await getCharacter(userId, characterId))!.pools.find((p) => p.key === 'soulfire')).toBeUndefined();

      // Manual -1 writes a ledger row; a clamp at max writes the change only.
      await adjustCharacterPool(userId, characterId, 'vowfire', -1);
      expect(await vowfire()).toMatchObject({ current: 2, max: 3 });
      const ledger = (await query<any>(`SELECT * FROM character_resource_ledger WHERE character_id=$1`, [characterId])).rows;
      expect(ledger).toHaveLength(1);
      expect(ledger[0]).toMatchObject({ pool: 'pool:vowfire', label: 'Vowfire', delta: -1, before_value: 3, after_value: 2, reason: 'manual', actor_user_id: userId });
      await adjustCharacterPool(userId, characterId, 'vowfire', 99);
      expect(await vowfire()).toMatchObject({ current: 3 });
      await expect(adjustCharacterPool(userId, characterId, 'nope', 1)).rejects.toThrow('Unknown resource pool.');
      await adjustCharacterPool(userId, characterId, 'vowfire', -2);

      // A whole-sheet Save keeps the pool row (and the pool is not a sheet resource).
      const form = new FormData();
      form.set('name', 'Pools');
      await updateCharacter(userId, characterId, form, 'IT save');
      expect(await vowfire()).toMatchObject({ current: 1 });
      expect((await getCharacter(userId, characterId))!.resources.some((r) => r.key.startsWith('pool:'))).toBe(false);
      const saved = (await query<any>(`SELECT id FROM character_versions WHERE character_id=$1 ORDER BY created_at DESC LIMIT 1`, [characterId])).rows[0].id;

      // Long rest: pool full, HP to max, half the hit dice (min 1), dawn counter refilled.
      await query(`UPDATE character_resources SET current_value=3, max_value=20 WHERE character_id=$1 AND resource_key='hp'`, [characterId]);
      const hpMax = 20;
      await query(`INSERT INTO character_resources (character_id, resource_key, label, current_value, max_value, sort_order) VALUES
        ($1,'hit_dice_0','Hit Dice',0,1,99), ($1,'hit_dice_1','Hit Dice',0,5,100), ($1,'hit_dice_2','Hit Dice',5,5,101)`, [characterId]);
      const counterDef = (await query<{ id: string }>(
        `INSERT INTO content_resource_definitions (content_id, resource_key, label, max_value_expression, recharge_period) VALUES ($1,'dawnuse','Dawn use','2','dawn') RETURNING id`, [feat])).rows[0].id;
      const instanceId = (await query<{ id: string }>(`SELECT id FROM character_content_instances WHERE character_id=$1`, [characterId])).rows[0].id;
      await query(`INSERT INTO character_content_resources (character_content_id, resource_definition_id, current_value, max_value) VALUES ($1,$2,0,2)`, [instanceId, counterDef]);
      const counter = async () => (await query<any>(`SELECT current_value FROM character_content_resources WHERE character_content_id=$1`, [instanceId])).rows[0].current_value;
      await query(`UPDATE characters SET metadata_json = metadata_json || '{"deathSaveSuccesses":2,"deathSaveFailures":1}'::jsonb WHERE id=$1`, [characterId]);
      await restCharacter(userId, characterId, 'short_rest');
      expect((await query<any>(`SELECT metadata_json FROM characters WHERE id=$1`, [characterId])).rows[0].metadata_json.deathSaveSuccesses).toBe(2); // a short rest keeps them
      expect(await vowfire()).toMatchObject({ current: 1 }); // a long_rest pool: a short rest leaves it
      expect(await counter()).toBe(0);
      await restCharacter(userId, characterId, 'long_rest');
      expect(await vowfire()).toMatchObject({ current: 2 }); // the empty-form Save dropped the ring, so the max is 2
      const res = async (key: string) => (await query<any>(`SELECT current_value FROM character_resources WHERE character_id=$1 AND resource_key=$2`, [characterId, key])).rows[0].current_value;
      expect(await res('hp')).toBe(hpMax);
      expect([await res('hit_dice_0'), await res('hit_dice_1'), await res('hit_dice_2')]).toEqual([1, 2, 5]);
      expect(await counter()).toBe(2);
      const saves = (await query<any>(`SELECT metadata_json FROM characters WHERE id=$1`, [characterId])).rows[0].metadata_json;
      expect([saves.deathSaveSuccesses, saves.deathSaveFailures]).toEqual([0, 0]); // long rest clears death saves
      const rest = (await query<any>(`SELECT pool FROM character_resource_ledger WHERE character_id=$1 AND reason='rest' ORDER BY pool`, [characterId])).rows.map((r) => r.pool);
      expect(rest).toEqual(['hit_dice_0', 'hit_dice_1', 'hp', 'pool:vowfire']);

      // Archived pool the character still holds: +/- works (no throw), and a raised max does not top up.
      await query(`UPDATE resource_pool_definitions SET is_archived=true WHERE pool_key='vowfire'`);
      try {
        await adjustCharacterPool(userId, characterId, 'vowfire', -1);
        expect(await vowfire()).toMatchObject({ current: 1 });
      } finally {
        await query(`UPDATE resource_pool_definitions SET is_archived=false WHERE pool_key='vowfire'`);
      }
      await link(feat, 'manual', '1'); // max up by 1 (feat instance is active): current stays put until a rest
      expect(await vowfire()).toMatchObject({ current: 1, max: 3 });
      await query(`DELETE FROM content_modifier_links WHERE content_id=$1 AND activation_type='manual'`, [feat]);

      // Snapshot round trip: the saved version held 1 (spent); the first version had no pool row, so it restores full.
      await restoreCharacterVersion(userId, characterId, saved);
      expect(await vowfire()).toMatchObject({ current: 1 });
      const first = (await query<any>(`SELECT id FROM character_versions WHERE character_id=$1 ORDER BY created_at ASC LIMIT 1`, [characterId])).rows[0].id;
      await restoreCharacterVersion(userId, characterId, first);
      // (the restore also removed the feat, so re-add it: no row means full)
      expect((await query(`SELECT 1 FROM character_resources WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId])).rows).toHaveLength(0);
      await query(`INSERT INTO character_content_instances (character_id, content_id) VALUES ($1,$2)`, [characterId, feat]);
      expect(await vowfire()).toMatchObject({ current: 2, max: 2 });
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]); // cascades the character, ledger and instances
      await query(`DELETE FROM content_definitions WHERE id = ANY($1::uuid[])`, [contentIds]);
    }
  });

  it('pays activation costs through the engine: defaults, explicit costs, upcast, access charges, shortfalls and races', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }
    const { query } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const { castCharacterSpell, castCharacterSpellDetailed, useInventoryCatalogueItem, triggerCharacterContentActions, spendSpellSlot, restCharacter } = await import('./services/catalogue');
    const { addContentResourceAction } = await import('./services/content-admin');
    const { CostShortfallError } = await import('./services/cost-engine');
    const tag = `zzact${crypto.randomBytes(4).toString('hex')}`;
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Act', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    const contentIds: string[] = [];
    const actionKeys: string[] = [];
    try {
      const characterId = await createCharacter(userId, 'Acting');
      const content = async (type: string, suffix: string, cost: unknown = null) => {
        const id = (await query<{ id: string }>(
          `INSERT INTO content_definitions (content_key, content_type, name, cost_json) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
          [`${type}:${tag}${suffix}`, type, `IT ${suffix}`, cost === null ? null : JSON.stringify(cost)])).rows[0].id;
        contentIds.push(id);
        return id;
      };
      const spell = async (suffix: string, level: number, cost: unknown = null) => {
        const id = await content('spell', suffix, cost);
        await query(`INSERT INTO spell_definitions (content_id, spell_level, casting_time, resolution_type) VALUES ($1,$2,'1 action','auto')`, [id, level]);
        const instance = (await query<{ id: string }>(
          `INSERT INTO character_content_instances (character_id, content_id, is_known, is_prepared) VALUES ($1,$2,true,true) RETURNING id`, [characterId, id])).rows[0].id;
        return { id, instance };
      };
      const setSlots = async (rows: Array<[string, number, number]>) => {
        await query(`DELETE FROM character_spell_slots WHERE character_id=$1`, [characterId]);
        for (const [type, level, n] of rows) {
          await query(`INSERT INTO character_spell_slots (character_id, slot_type, slot_level, current_slots, max_slots) VALUES ($1,$2,$3,$4,5)`, [characterId, type, level, n]);
        }
      };
      const slot = async (type: string, level: number) => (await query<any>(
        `SELECT current_slots FROM character_spell_slots WHERE character_id=$1 AND slot_type=$2 AND slot_level=$3`, [characterId, type, level])).rows[0].current_slots;
      const ledger = async (reason = 'cost') => (await query<any>(
        `SELECT * FROM character_resource_ledger WHERE character_id=$1 AND reason=$2 ORDER BY created_at, id`, [characterId, reason])).rows;
      const cast = (instanceId: string, extra: Record<string, string> = {}) => {
        const form = new FormData();
        form.set('instanceId', instanceId);
        for (const [k, v] of Object.entries(extra)) form.set(k, v);
        return castCharacterSpell(userId, characterId, form);
      };

      // Default cost: a level-1 spell spends the lowest slot, one ledger row, results list the spend.
      const magic = await spell('magic', 1);
      await setSlots([['standard', 1, 2], ['standard', 2, 1], ['standard', 3, 1]]);
      const results = await cast(magic.instance);
      expect(results[0]).toMatchObject({ label: 'Cost', target: 'Level 1 Spell Slot', before: 2, after: 1 });
      expect(await slot('standard', 1)).toBe(1);
      let rows = await ledger();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pool: 'spell_slot', label: 'Level 1 Spell Slot', delta: -1, before_value: 2, after_value: 1, source_label: 'IT magic', actor_user_id: userId });
      expect(rows[0].activation_id).toBeTruthy();

      // Upcast: slotLevel=3 spends L3, and the detailed cast reports which slot.
      const form = new FormData();
      form.set('instanceId', magic.instance);
      form.set('slotLevel', '3');
      const detailed = await castCharacterSpellDetailed(userId, characterId, form);
      expect(detailed.spent).toEqual({ slotType: 'standard', slotLevel: 3 });
      expect(await slot('standard', 3)).toBe(0);
      // Below-minimum request is a shortfall, not a silent fallback.
      await expect(cast(magic.instance, { slotLevel: '0' })).resolves.toBeTruthy(); // 0 = no choice
      await setSlots([['standard', 1, 0]]);
      await expect(cast(magic.instance)).rejects.toBeInstanceOf(CostShortfallError);

      // Cantrip: free.
      const cantrip = await spell('cantrip', 0);
      await setSlots([]);
      expect(await cast(cantrip.instance)).toEqual([]);

      // Explicit [L2 slot + Vowfire]: with no Vowfire, nothing is spent and the error says so.
      const hard = await spell('hard', 1, [{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }]);
      await setSlots([['standard', 2, 1]]);
      const before = (await ledger()).length;
      await expect(cast(hard.instance)).rejects.toMatchObject({ shortfalls: [{ label: 'Vowfire', needed: 1, available: 0 }] });
      expect(await slot('standard', 2)).toBe(1);
      expect((await ledger()).length).toBe(before);
      // Give the character Vowfire (a feat granting 2) and it pays both lines under one activation id.
      const modifierId = (await query<{ id: string }>(
        `SELECT id FROM modifier_definitions WHERE target='resource.vowfire.max' AND modifier_type='bonus' AND NOT is_archived LIMIT 1`)).rows[0].id;
      const feat = await content('feat', 'feat');
      await query(`INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, value_override_expression) VALUES ($1,$2,'known','2')`, [feat, modifierId]);
      await query(`INSERT INTO character_content_instances (character_id, content_id) VALUES ($1,$2)`, [characterId, feat]);
      await cast(hard.instance);
      expect(await slot('standard', 2)).toBe(0);
      const paid = (await ledger()).slice(before);
      expect(paid.map((r: any) => r.pool).sort()).toEqual(['pool:vowfire', 'spell_slot']);
      expect(new Set(paid.map((r: any) => r.activation_id)).size).toBe(1);
      expect((await query<any>(`SELECT current_value FROM character_resources WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId])).rows[0].current_value).toBe(1);

      // Item default: one of itself. Explicit charges: counter spent, quantity kept.
      const potion = await content('item', 'potion');
      const potionRow = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, quantity) VALUES ($1,'IT Potion',$2,3) RETURNING id`, [characterId, potion])).rows[0].id;
      await useInventoryCatalogueItem(userId, characterId, potionRow);
      expect((await query<any>(`SELECT quantity FROM character_inventory_items WHERE id=$1`, [potionRow])).rows[0].quantity).toBe(2);
      expect((await ledger()).some((r: any) => r.pool === 'item' && r.delta === -1)).toBe(true);
      const wand = await content('item', 'wand', [{ pool: 'charges', amount: 1 }]);
      const counterDef = (await query<{ id: string }>(
        `INSERT INTO content_resource_definitions (content_id, resource_key, label, max_value_expression) VALUES ($1,'charge','Charges','3') RETURNING id`, [wand])).rows[0].id;
      const wandRow = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, quantity) VALUES ($1,'IT Wand',$2,1) RETURNING id`, [characterId, wand])).rows[0].id;
      await query(`INSERT INTO character_inventory_resources (inventory_item_id, resource_definition_id, current_value, max_value) VALUES ($1,$2,3,3)`, [wandRow, counterDef]);
      await useInventoryCatalogueItem(userId, characterId, wandRow);
      expect((await query<any>(`SELECT current_value FROM character_inventory_resources WHERE inventory_item_id=$1`, [wandRow])).rows[0].current_value).toBe(2);
      expect((await query<any>(`SELECT quantity FROM character_inventory_items WHERE id=$1`, [wandRow])).rows[0].quantity).toBe(1);

      // Access via charges: spends the item's counter, not a slot.
      const bolt = await content('spell', 'bolt');
      await query(`INSERT INTO spell_definitions (content_id, spell_level, casting_time, resolution_type) VALUES ($1,1,'1 action','auto')`, [bolt]);
      const access = (await query<{ id: string }>(
        `INSERT INTO content_spell_access (owner_content_id, spell_content_id, access_type, availability_type, resource_definition_id, resource_cost_expression)
         VALUES ($1,$2,'charges','carried',$3,'2') RETURNING id`, [wand, bolt, counterDef])).rows[0].id;
      await setSlots([['standard', 1, 1]]);
      const accessForm = new FormData();
      accessForm.set('spellAccessId', access);
      accessForm.set('inventoryItemId', wandRow);
      await castCharacterSpell(userId, characterId, accessForm);
      expect((await query<any>(`SELECT current_value FROM character_inventory_resources WHERE inventory_item_id=$1`, [wandRow])).rows[0].current_value).toBe(0);
      expect(await slot('standard', 1)).toBe(1);
      await expect(castCharacterSpell(userId, characterId, accessForm)).rejects.toBeInstanceOf(CostShortfallError);

      // Content "use actions" with an explicit cost pays it; free by default.
      const gift = await content('feat', 'gift', [{ pool: 'vowfire', amount: 1 }]);
      const giftInstance = (await query<{ id: string }>(`INSERT INTO character_content_instances (character_id, content_id) VALUES ($1,$2) RETURNING id`, [characterId, gift])).rows[0].id;
      await triggerCharacterContentActions(userId, characterId, giftInstance);
      expect((await query<any>(`SELECT current_value FROM character_resources WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId])).rows[0].current_value).toBe(0);
      await expect(triggerCharacterContentActions(userId, characterId, giftInstance)).rejects.toBeInstanceOf(CostShortfallError);
      expect(await triggerCharacterContentActions(userId, characterId, (await query<any>(`SELECT id FROM character_content_instances WHERE character_id=$1 AND content_id=$2`, [characterId, feat])).rows[0].id)).toEqual([]);

      // Manual slot +/- logs a 'manual' row.
      await spendSpellSlot(userId, characterId, 'standard', 1, 1);
      expect((await ledger('manual')).some((r: any) => r.pool === 'spell_slot' && r.delta === 1)).toBe(true);

      // Freeform item (no catalogue link): same cost line and ledger row, quantity -1.
      const freeRow = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, quantity) VALUES ($1,'IT Free',2) RETURNING id`, [characterId])).rows[0].id;
      const freeResults = await useInventoryCatalogueItem(userId, characterId, freeRow);
      expect(freeResults[0]).toMatchObject({ label: 'Cost', target: 'Item quantity', before: 2, after: 1 });
      expect((await query<any>(`SELECT quantity FROM character_inventory_items WHERE id=$1`, [freeRow])).rows[0].quantity).toBe(1);
      expect((await ledger()).some((r: any) => r.pool === 'item' && r.pool_detail.inventoryId === freeRow)).toBe(true);

      // An explicit item line plus an on_use spend_item step pays once (the step keeps paying).
      const dbl = await content('item', 'dbl', [{ pool: 'item', amount: 1 }]);
      const stepForm = new FormData();
      for (const [k, v] of Object.entries({ contentId: dbl, activationType: 'on_use', stepType: 'spend_item', valueExpression: '1', actionLabel: 'Drink' })) stepForm.set(k, v);
      await addContentResourceAction(stepForm);
      actionKeys.push(`action:content:${dbl}:on_use`);
      const dblRow = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, quantity) VALUES ($1,'IT Dbl',$2,3) RETURNING id`, [characterId, dbl])).rows[0].id;
      await useInventoryCatalogueItem(userId, characterId, dblRow);
      expect((await query<any>(`SELECT quantity FROM character_inventory_items WHERE id=$1`, [dblRow])).rows[0].quantity).toBe(2);

      // Lock order: a [slot + Vowfire] cast and a long rest in parallel both complete (no deadlock).
      for (let i = 0; i < 6; i++) {
        await setSlots([['standard', 2, 2]]);
        await query(`UPDATE character_resources SET current_value=2, max_value=2 WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId]);
        const both = await Promise.allSettled([cast(hard.instance), restCharacter(userId, characterId, 'long_rest'), restCharacter(userId, characterId, 'short_rest')]);
        expect(both.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
      }

      // Two parallel casts on the last slot: one wins, one gets a shortfall.
      await setSlots([['standard', 1, 1]]);
      const race = await Promise.allSettled([cast(magic.instance), cast(magic.instance)]);
      expect(race.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const lost = race.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(lost.reason).toBeInstanceOf(CostShortfallError);
      expect(await slot('standard', 1)).toBe(0);
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      await query(`DELETE FROM content_definitions WHERE id = ANY($1::uuid[])`, [contentIds]);
      await query(`DELETE FROM content_definitions WHERE content_type='action' AND content_key = ANY($1::text[])`, [actionKeys]);
    }
  });
});
