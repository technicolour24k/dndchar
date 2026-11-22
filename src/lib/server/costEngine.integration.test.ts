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
});
