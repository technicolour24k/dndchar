import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of migration 041 (container backfill). SKIPPED unless CONTAINER_DB_TEST=1, so the
// normal suite never touches a database. Local DB only (the guard below refuses anything else).
// Everything runs inside ONE transaction that is rolled back, so nothing is left behind. It also
// works before or after 041 has been applied, since it re-runs the file text itself.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   CONTAINER_DB_TEST=1 npx vitest run src/lib/server/containerBackfill.integration.test.ts
const enabled = process.env.CONTAINER_DB_TEST === '1';
const migration = fs.readFileSync(path.resolve('src/lib/server/db/migrations/041_container_backfill.sql'), 'utf8');

describe.skipIf(!enabled)('041 container backfill', () => {
  it('backfills drift fixtures idempotently', async () => {
    // Guard FIRST, before any query: local database only, and no ?host= override.
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { getPool } = await import('$lib/server/db');
    const tag = `zzbackfill${crypto.randomBytes(4).toString('hex')}`;
    const client = await getPool().connect();
    const q = async <T extends Record<string, any>>(text: string, params: unknown[] = []) => (await client.query(text, params)).rows as T[];
    try {
      await client.query('BEGIN');

      // Fixtures (legacy-only drift).
      const userId = (await q<{ id: string }>(
        `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Backfill', 'x') RETURNING id`, [`${tag}@example.invalid`]))[0].id;
      const characterId = (await q<{ id: string }>(
        `INSERT INTO characters (owner_user_id, name) VALUES ($1, 'Backfill') RETURNING id`, [userId]))[0].id;
      const modifierId = (await q<{ id: string }>(`SELECT id FROM modifier_definitions LIMIT 1`))[0]?.id;
      expect(modifierId, 'needs at least one modifier_definitions row').toBeTruthy();
      const effectId = (await q<{ id: string }>(
        `INSERT INTO effect_definitions (effect_key, name, source_type, description, duration_type, is_condition, sort_order, is_homebrew)
         VALUES ($1, 'IT Condition', 'homebrew', 'legacy desc', 'timed', true, 7, true) RETURNING id`, [tag]))[0].id;
      await q(`INSERT INTO effect_sources (effect_id, source_type, source_ref, source_name) VALUES ($1, 'homebrew', $2, 'IT source')`, [effectId, tag]);
      await q(`INSERT INTO effect_modifier_links (effect_id, modifier_id, priority) VALUES ($1, $2, 3)`, [effectId, modifierId]);
      await q(`INSERT INTO active_character_effects (character_id, effect_id) VALUES ($1, $2)`, [characterId, effectId]);
      const itemId = (await q<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1, 'item', 'IT Item') RETURNING id`, [`it:${tag}`]))[0].id;
      await q(`INSERT INTO content_effect_links (content_id, effect_id, activation_type) VALUES ($1, $2, 'equipped')`, [itemId, effectId]);
      const actionId = (await q<{ id: string }>(
        `INSERT INTO action_definitions (action_key, name, description) VALUES ($1, 'IT Action', 'legacy action') RETURNING id`, [tag]))[0].id;
      await q(`INSERT INTO content_action_links (content_id, action_id, trigger_type) VALUES ($1, $2, 'on_use')`, [itemId, actionId]);
      await q(`INSERT INTO action_steps (action_id, step_type, effect_id, sort_order) VALUES ($1, 'apply_effect', $2, 0)`, [actionId, effectId]);
      await q(`INSERT INTO action_steps (action_id, step_type, sort_order) VALUES ($1, 'resource_change', 1)`, [actionId]);

      // Run 041 twice: the second run must change nothing and must not duplicate anything.
      await client.query(migration);
      await client.query(migration);

      const [cond] = await q<any>(
        `SELECT * FROM content_definitions WHERE content_type = 'condition' AND content_key = $1`, [`condition:${tag}`]);
      expect(cond).toBeTruthy();
      expect(cond.source_kind).toBe('homebrew');
      expect(cond.description).toBe('legacy desc');
      expect(cond.duration_type).toBe('rounds');
      expect(cond.metadata_json).toMatchObject({
        sourceType: 'homebrew', isCondition: true, isHomebrew: true, sortOrder: 7, legacyDurationType: 'timed', legacyEffectId: effectId
      });
      expect(cond.metadata_json.legacySources).toHaveLength(1);
      expect(cond.metadata_json.legacySources[0]).toMatchObject({ sourceRef: tag, sourceName: 'IT source' });

      // Legacy wins when the container drifts.
      await q(`UPDATE content_definitions SET name = 'drifted' WHERE id = $1`, [cond.id]);
      await client.query(migration);
      expect((await q<any>(`SELECT name FROM content_definitions WHERE id = $1`, [cond.id]))[0].name).toBe('IT Condition');

      expect(await q(`SELECT 1 FROM content_modifier_links WHERE content_id = $1 AND modifier_id = $2 AND activation_type = 'carried' AND priority = 3`, [cond.id, modifierId])).toHaveLength(1);
      expect((await q<any>(`SELECT container_id FROM active_character_effects WHERE character_id = $1`, [characterId]))[0].container_id).toBe(cond.id);
      expect(await q(`SELECT 1 FROM content_grants WHERE source_content_id = $1 AND granted_content_id = $2 AND activation_type = 'equipped'`, [itemId, cond.id])).toHaveLength(1);

      const [action] = await q<any>(`SELECT * FROM content_definitions WHERE content_type = 'action' AND content_key = $1`, [`action:${tag}`]);
      expect(action).toBeTruthy();
      expect(action.activation_type).toBe('active_use');
      const links = await q<any>(`SELECT action_container_id FROM content_action_links WHERE content_id = $1`, [itemId]);
      expect(links).toHaveLength(1);
      expect(links[0].action_container_id).toBe(action.id);
      const steps = await q<any>(`SELECT step_type, container_id, effect_container_id FROM action_steps WHERE action_id = $1 ORDER BY sort_order`, [actionId]);
      expect(steps).toHaveLength(2);
      expect(steps.every((s) => s.container_id === action.id)).toBe(true);
      expect(steps[0].effect_container_id).toBe(cond.id);
      expect(steps[1].effect_container_id).toBeNull();

      // No duplicates from the repeat runs.
      expect(await q(`SELECT 1 FROM content_definitions WHERE content_key IN ($1, $2)`, [`condition:${tag}`, `action:${tag}`])).toHaveLength(2);
      expect(await q(`SELECT 1 FROM content_modifier_links WHERE content_id = $1`, [cond.id])).toHaveLength(1);
      expect(await q(`SELECT 1 FROM content_grants WHERE granted_content_id = $1`, [cond.id])).toHaveLength(1);

      // The container-keyed index rejects a second link for the same (content, container, trigger).
      await client.query('SAVEPOINT dup');
      await expect(
        client.query(`INSERT INTO content_action_links (content_id, action_id, trigger_type, action_container_id) VALUES ($1, NULL, 'on_use', $2)`, [itemId, action.id])
      ).rejects.toThrow(/content_action_links_container_unique_idx/);
      await client.query('ROLLBACK TO SAVEPOINT dup');
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
