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

  it('authors costs through the admin editor: refuses bad lines, saves, and goes back to the default', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Refusing to run: database host is not local.');
    const { query } = await import('$lib/server/db');
    const { updateAdminContent } = await import('./services/content-admin');
    const { listCharacterContent } = await import('./services/catalogue');
    const { createCharacter } = await import('./services/characters');
    const tag = `zzadm${crypto.randomBytes(4).toString('hex')}`;
    const userId = (await query<{ id: string }>(`INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Adm', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    let spellId = '';
    try {
      spellId = (await query<{ id: string }>(`INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1,'spell','IT Misty') RETURNING id`, [`spell:${tag}`])).rows[0].id;
      await query(`INSERT INTO spell_definitions (content_id, spell_level, casting_time) VALUES ($1,2,'1 action')`, [spellId]);
      const save = (costJson: string) => {
        const form = new FormData();
        form.set('contentId', spellId); form.set('name', 'IT Misty'); form.set('description', ''); form.set('spellLevel', '2'); form.set('castingTime', '1 action');
        form.set('costJson', costJson);
        return updateAdminContent(form);
      };
      const stored = async () => (await query<any>(`SELECT cost_json FROM content_definitions WHERE id=$1`, [spellId])).rows[0].cost_json;
      await expect(save('not json')).rejects.toThrow();
      await expect(save(JSON.stringify([{ pool: 'vowfyre', amount: 1 }]))).rejects.toThrow(/isn't an active resource pool/);
      await expect(save(JSON.stringify([{ pool: 'charges', amount: 1 }]))).rejects.toThrow(/counter/);
      await expect(save(JSON.stringify([{ pool: 'spell_slot', amount: 1 }]))).rejects.toThrow(/level/);
      expect(await stored()).toBeNull();
      await save(JSON.stringify([{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }]));
      expect(await stored()).toEqual([{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }]);
      // The sheet shows it as a chip, with the pool's label.
      const characterId = await createCharacter(userId, 'Chips');
      await query(`INSERT INTO character_content_instances (character_id, content_id) VALUES ($1,$2)`, [characterId, spellId]);
      expect((await listCharacterContent(characterId))[0].cost?.summary).toBe('L2 slot + 1 Vowfire + 1 action'); // an explicit cost inherits the default turn line (action economy Unit 1)
      // Caps, and a since-archived pool already in the stored cost can still be saved.
      await expect(save(JSON.stringify(Array.from({ length: 21 }, () => ({ pool: 'action', amount: 1 }))))).rejects.toThrow(/at most 20/);
      await expect(save(JSON.stringify([{ pool: 'action', amount: 1, pad: 'x'.repeat(4100) }]))).rejects.toThrow(/too long/);
      await query(`UPDATE resource_pool_definitions SET is_archived=true WHERE pool_key='vowfire'`);
      try {
        await save(JSON.stringify([{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }])); // unchanged: no re-validation
        await save(JSON.stringify([{ pool: 'spell_slot', amount: 1, level: 3 }, { pool: 'vowfire', amount: 1 }])); // edited, archived pool kept
        await expect(save(JSON.stringify([{ pool: 'vowfire', amount: 1 }, { pool: 'soulfire', amount: 1 }, { pool: 'nope', amount: 1 }]))).rejects.toThrow(/nope/);
      } finally {
        await query(`UPDATE resource_pool_definitions SET is_archived=false WHERE pool_key='vowfire'`);
      }
      await save(JSON.stringify([{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 1 }]));
      await save('[]');
      expect(await stored()).toEqual([]);
      expect((await listCharacterContent(characterId))[0].cost?.summary).toBe('1 action'); // [] = no resources, the spell still uses its action
      await save('');
      expect(await stored()).toBeNull();
      expect((await listCharacterContent(characterId))[0].cost?.summary).toBe('L2 slot + 1 action');
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      if (spellId) await query(`DELETE FROM content_definitions WHERE id = $1`, [spellId]);
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
      // The access rows first: spell_content_id is RESTRICT, so deleting a spell before its owner item can fail.
      await query(`DELETE FROM content_spell_access WHERE spell_content_id = ANY($1::uuid[]) OR owner_content_id = ANY($1::uuid[])`, [contentIds]);
      await query(`DELETE FROM content_definitions WHERE id = ANY($1::uuid[])`, [contentIds]);
      await query(`DELETE FROM content_definitions WHERE content_type='action' AND content_key = ANY($1::text[])`, [actionKeys]);
    }
  });
  it('overrides pay what they can, record the shortfall and who allowed it, and a waiver spends nothing', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }
    const { query } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const { castCharacterSpell } = await import('./services/catalogue');
    const { CostShortfallError } = await import('./services/cost-engine');
    const tag = `zzovr${crypto.randomBytes(4).toString('hex')}`;
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Override', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    const contentIds: string[] = [];
    try {
      const characterId = await createCharacter(userId, 'Overspender');
      const content = async (type: string, suffix: string, cost: unknown = null) => {
        const id = (await query<{ id: string }>(
          `INSERT INTO content_definitions (content_key, content_type, name, cost_json) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
          [`${type}:${tag}${suffix}`, type, `IT ${suffix}`, cost === null ? null : JSON.stringify(cost)])).rows[0].id;
        contentIds.push(id);
        return id;
      };
      const spell = async (suffix: string, level: number, cost: unknown) => {
        const id = await content('spell', suffix, cost);
        await query(`INSERT INTO spell_definitions (content_id, spell_level, casting_time, resolution_type) VALUES ($1,$2,'1 action','auto')`, [id, level]);
        return (await query<{ id: string }>(
          `INSERT INTO character_content_instances (character_id, content_id, is_known, is_prepared) VALUES ($1,$2,true,true) RETURNING id`, [characterId, id])).rows[0].id;
      };
      const setSlots = async (rows: Array<[string, number, number]>) => {
        await query(`DELETE FROM character_spell_slots WHERE character_id=$1`, [characterId]);
        for (const [type, level, n] of rows) {
          await query(`INSERT INTO character_spell_slots (character_id, slot_type, slot_level, current_slots, max_slots) VALUES ($1,$2,$3,$4,5)`, [characterId, type, level, n]);
        }
      };
      const slot = async (level: number) => (await query<any>(
        `SELECT current_slots FROM character_spell_slots WHERE character_id=$1 AND slot_type='standard' AND slot_level=$2`, [characterId, level])).rows[0].current_slots;
      const rowsFor = async () => (await query<any>(
        `SELECT * FROM character_resource_ledger WHERE character_id=$1 AND reason='cost' ORDER BY created_at, id`, [characterId])).rows;
      const cast = (instanceId: string, override?: any) => {
        const form = new FormData();
        form.set('instanceId', instanceId);
        return castCharacterSpell(userId, characterId, form, override);
      };

      // The character holds 1 Vowfire (a feat granting 1); the spell costs a level 2 slot + 2 Vowfire.
      const modifierId = (await query<{ id: string }>(
        `SELECT id FROM modifier_definitions WHERE target='resource.vowfire.max' AND modifier_type='bonus' AND NOT is_archived LIMIT 1`)).rows[0].id;
      const feat = await content('feat', 'feat');
      await query(`INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, value_override_expression) VALUES ($1,$2,'known','1')`, [feat, modifierId]);
      await query(`INSERT INTO character_content_instances (character_id, content_id) VALUES ($1,$2)`, [characterId, feat]);
      const smite = await spell('smite', 1, [{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 2 }]);
      await setSlots([['standard', 2, 1]]);

      // No override: shortfall, nothing spent.
      await expect(cast(smite)).rejects.toBeInstanceOf(CostShortfallError);
      expect(await slot(2)).toBe(1);

      // An approval pays what it can: the slot and the 1 Vowfire it has; the shortfall is recorded per line.
      const requestId = crypto.randomUUID();
      const used: any[] = [];
      await cast(smite, { kind: 'dm_approved', approvedByUserId: userId, approvalRequestId: requestId, roomId: 'ROOM', onUsed: (u: any) => used.push(u) });
      expect(await slot(2)).toBe(0);
      expect(used).toHaveLength(1);
      expect(used[0]).toMatchObject({ kind: 'dm_approved', label: 'IT smite', waived: false, shortfalls: [{ label: 'Vowfire', needed: 2, available: 1 }] });
      let rows = await rowsFor();
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.override_kind === 'dm_approved' && r.approved_by_user_id === userId && r.approval_request_id === requestId && r.room_id === 'ROOM')).toBe(true);
      expect(new Set(rows.map((r: any) => r.activation_id)).size).toBe(1);
      expect(rows.find((r: any) => r.pool === 'spell_slot')).toMatchObject({ delta: -1, shortfall: 0 });
      expect(rows.find((r: any) => r.pool === 'pool:vowfire')).toMatchObject({ delta: -1, before_value: 1, after_value: 0, shortfall: 1 });
      expect((await query<any>(`SELECT current_value FROM character_resources WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId])).rows[0].current_value).toBe(0);

      // "Spend nothing": rows with delta 0 and waived, the slot untouched.
      await setSlots([['standard', 2, 1]]);
      await query(`DELETE FROM character_resource_ledger WHERE character_id=$1`, [characterId]);
      await cast(smite, { kind: 'dm_approved', approvedByUserId: userId, approvalRequestId: crypto.randomUUID(), waive: true });
      expect(await slot(2)).toBe(1);
      rows = await rowsFor();
      expect(rows).toHaveLength(2);
      expect(rows.every((r: any) => r.delta === 0 && r.pool_detail.waived === true)).toBe(true);
      expect(rows.find((r: any) => r.pool === 'pool:vowfire').shortfall).toBe(2);

      // A line with no source at all (no slot of that level) still gets a row, and pays nothing.
      await setSlots([]);
      await query(`DELETE FROM character_resource_ledger WHERE character_id=$1`, [characterId]);
      await cast(smite, { kind: 'self_override', roomId: null });
      rows = await rowsFor();
      expect(rows.find((r: any) => r.pool === 'spell_slot')).toMatchObject({ delta: 0, shortfall: 1, override_kind: 'self_override', before_value: null });
      expect(rows.every((r: any) => r.reviewed_at === null)).toBe(true);

      // An override that isn't needed (affordable) pays normally: no override kind, onUsed never fires.
      await setSlots([['standard', 2, 3]]);
      await query(`UPDATE character_resources SET current_value=1, max_value=1 WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId]);
      const easy = await spell('easy', 1, [{ pool: 'spell_slot', amount: 1, level: 2 }]);
      await query(`DELETE FROM character_resource_ledger WHERE character_id=$1`, [characterId]);
      let fired = false;
      await cast(easy, { kind: 'dm_self', onUsed: () => { fired = true; } });
      expect(fired).toBe(false);
      rows = await rowsFor();
      expect(rows).toHaveLength(1);
      expect(rows[0].override_kind).toBeNull();
      expect(await slot(2)).toBe(2);
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      await query(`DELETE FROM content_definitions WHERE id = ANY($1::uuid[])`, [contentIds]);
    }
  });
  it('reviews self overrides: scoped to the campaign DM, OK marks, Undo refunds (capped, with notes) once', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }
    const { query } = await import('$lib/server/db');
    const { createCampaign } = await import('./services/campaigns');
    const { castCharacterSpell, useInventoryCatalogueItem } = await import('./services/catalogue');
    const { listLedger, listUnreviewedOverrides, reviewOverride } = await import('./services/resource-pools');
    const tag = `zzrev${crypto.randomBytes(4).toString('hex')}`;
    const mkUser = async (name: string) => (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, $2, 'x') RETURNING id`, [`${tag}${name}@example.invalid`, `IT ${name}`])).rows[0].id;
    const dmId = await mkUser('dm');
    const playerId = await mkUser('player');
    const otherDmId = await mkUser('otherdm');
    const contentIds: string[] = [];
    const campaignIds: string[] = [];
    try {
      const campaignId = await createCampaign(dmId, `${tag} A`);
      const otherCampaignId = await createCampaign(otherDmId, `${tag} B`);
      campaignIds.push(campaignId, otherCampaignId);
      await query(`INSERT INTO campaign_members (campaign_id, user_id, role) VALUES ($1,$2,'player')`, [campaignId, playerId]);
      const characterId = (await query<{ id: string }>(
        `INSERT INTO characters (owner_user_id, name, campaign_id) VALUES ($1, 'Reviewed', $2) RETURNING id`, [playerId, campaignId])).rows[0].id;
      const content = async (type: string, suffix: string, cost: unknown) => {
        const id = (await query<{ id: string }>(
          `INSERT INTO content_definitions (content_key, content_type, name, cost_json) VALUES ($1,$2,$3,$4::jsonb) RETURNING id`,
          [`${type}:${tag}${suffix}`, type, `IT ${suffix}`, JSON.stringify(cost)])).rows[0].id;
        contentIds.push(id);
        return id;
      };
      const modifierId = (await query<{ id: string }>(
        `SELECT id FROM modifier_definitions WHERE target='resource.vowfire.max' AND modifier_type='bonus' AND NOT is_archived LIMIT 1`)).rows[0].id;
      const feat = await content('feat', 'feat', []);
      await query(`INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, value_override_expression) VALUES ($1,$2,'known','1')`, [feat, modifierId]);
      await query(`INSERT INTO character_content_instances (character_id, content_id) VALUES ($1,$2)`, [characterId, feat]);
      const spellId = await content('spell', 'smite', [{ pool: 'spell_slot', amount: 1, level: 2 }, { pool: 'vowfire', amount: 2 }]);
      await query(`INSERT INTO spell_definitions (content_id, spell_level, casting_time, resolution_type) VALUES ($1,1,'1 action','auto')`, [spellId]);
      const instance = (await query<{ id: string }>(
        `INSERT INTO character_content_instances (character_id, content_id, is_known, is_prepared) VALUES ($1,$2,true,true) RETURNING id`, [characterId, spellId])).rows[0].id;
      const setSlot = async (n: number) => {
        await query(`DELETE FROM character_spell_slots WHERE character_id=$1`, [characterId]);
        await query(`INSERT INTO character_spell_slots (character_id, slot_type, slot_level, current_slots, max_slots) VALUES ($1,'standard',2,$2,3)`, [characterId, n]);
      };
      const slot = async () => (await query<any>(`SELECT current_slots FROM character_spell_slots WHERE character_id=$1`, [characterId])).rows[0].current_slots;
      const vowfire = async () => (await query<any>(`SELECT current_value FROM character_resources WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId])).rows[0].current_value;
      const cast = async () => {
        const form = new FormData();
        form.set('instanceId', instance);
        await castCharacterSpell(playerId, characterId, form, { kind: 'self_override', roomId: null });
      };

      // Two unreviewed overspends. Activation A: slot 1 -> 0 and Vowfire 1 -> 0 (short 1).
      await setSlot(1);
      await cast();
      expect(await slot()).toBe(0);
      expect(await vowfire()).toBe(0);
      let pending = await listUnreviewedOverrides(campaignId);
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ characterName: 'Reviewed', sourceLabel: 'IT smite', shortText: '1 Vowfire' });
      expect(await listUnreviewedOverrides(otherCampaignId)).toHaveLength(0);
      const first = pending[0].activationId;

      // Scoping: another campaign's DM, a plain player and a stranger can't review it. Nothing changes.
      await expect(reviewOverride(otherDmId, campaignId, first, 'undo')).rejects.toThrow();
      await expect(reviewOverride(playerId, campaignId, first, 'undo')).rejects.toThrow();
      expect((await reviewOverride(otherDmId, otherCampaignId, first, 'undo')).status).toBe('not_found');
      expect(await slot()).toBe(0);

      // Undo: slot and Vowfire come back, as 'refund' rows pointing at what they reverse; the row is reviewed.
      const undone = await reviewOverride(dmId, campaignId, first, 'undo');
      expect(undone).toMatchObject({ status: 'undone', characterName: 'Reviewed', sourceLabel: 'IT smite' });
      expect(undone.refunded).toEqual(['1 Level 2 Spell Slot', '1 Vowfire']);
      expect(undone.message).toContain('needs fixing by hand');
      expect(await slot()).toBe(1);
      expect(await vowfire()).toBe(1);
      const rows = await query<any>(`SELECT * FROM character_resource_ledger WHERE character_id=$1 AND activation_id=$2 ORDER BY created_at, id`, [characterId, first]);
      const refunds = rows.rows.filter((r: any) => r.reason === 'refund');
      expect(refunds).toHaveLength(2);
      expect(refunds.every((r: any) => r.refund_of && r.delta === 1 && r.override_kind === null)).toBe(true);
      expect(rows.rows.filter((r: any) => r.reason === 'cost').every((r: any) => r.review_outcome === 'undone' && r.reviewed_by_user_id === dmId)).toBe(true);
      expect(await listUnreviewedOverrides(campaignId)).toHaveLength(0);
      const view = await listLedger(characterId);
      expect(view.some((r) => r.badge === 'Undone by DM')).toBe(true);
      expect(view.some((r) => r.badge === 'Refund')).toBe(true);

      // A second undo does nothing.
      expect((await reviewOverride(dmId, campaignId, first, 'undo')).status).toBe('already_reviewed');
      expect(await slot()).toBe(1);
      expect(await vowfire()).toBe(1);

      // Activation B, then the pool is topped up before the undo: the refund is capped at the live max.
      await setSlot(1);
      await query(`UPDATE character_resources SET current_value=1, max_value=1 WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId]);
      await cast();
      pending = await listUnreviewedOverrides(campaignId);
      const second = pending[0].activationId;
      await query(`UPDATE character_resources SET current_value=1 WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId]);
      const capped = await reviewOverride(dmId, campaignId, second, 'undo');
      expect(capped.refunded).toEqual(['1 Level 2 Spell Slot']);
      expect(capped.message).toContain('Refunded 0 of 1 Vowfire');
      expect(await vowfire()).toBe(1);

      // OK just marks it: no refund, and it leaves the list.
      await setSlot(1);
      await query(`UPDATE character_resources SET current_value=1 WHERE character_id=$1 AND resource_key='pool:vowfire'`, [characterId]);
      await cast();
      const third = (await listUnreviewedOverrides(campaignId))[0].activationId;
      expect((await reviewOverride(dmId, campaignId, third, 'ok')).status).toBe('ok');
      expect(await slot()).toBe(0);
      expect(await listUnreviewedOverrides(campaignId)).toHaveLength(0);
      expect((await reviewOverride(dmId, campaignId, third, 'undo')).status).toBe('already_reviewed');
      expect((await listLedger(characterId)).some((r) => r.badge === "Player said DM OK'd it - DM marked OK")).toBe(true);

      // A removed item is noted, not an error.
      const potion = await content('item', 'potion', [{ pool: 'item', amount: 2 }]);
      const invId = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, source_content_id, quantity) VALUES ($1,'IT Potion',$2,1) RETURNING id`, [characterId, potion])).rows[0].id;
      await useInventoryCatalogueItem(playerId, characterId, invId, { kind: 'self_override', roomId: null });
      const fourth = (await listUnreviewedOverrides(campaignId))[0].activationId;
      await query(`DELETE FROM character_inventory_items WHERE id=$1`, [invId]);
      const gone = await reviewOverride(dmId, campaignId, fourth, 'undo');
      expect(gone.status).toBe('undone');
      expect(gone.message).toContain("Couldn't refund 1 Item quantity (it's gone)");
    } finally {
      await query(`DELETE FROM campaigns WHERE id = ANY($1::uuid[])`, [campaignIds]);
      await query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[dmId, playerId, otherDmId]]);
      await query(`DELETE FROM content_definitions WHERE id = ANY($1::uuid[])`, [contentIds]);
    }
  });
});
