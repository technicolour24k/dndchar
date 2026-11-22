import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { env } from '$env/dynamic/private';

// DB-backed check of the container-keyed active effects (container migration Unit 2). SKIPPED unless
// CONTAINER_DB_TEST=1. Local DB only (guarded below). Creates a throwaway user + character and
// deletes the user (cascading everything) at the end.
//
//   (DATABASE_URL must be unset in the shell; .env.local supplies the local one)
//   CONTAINER_DB_TEST=1 npx vitest run src/lib/server/containerEffects.integration.test.ts
const enabled = process.env.CONTAINER_DB_TEST === '1';

describe.skipIf(!enabled)('active effects on containers', () => {
  it('applies, refreshes, stacks, rejects, removes, resolves modifiers and round-trips snapshots', async () => {
    // Guard FIRST, before any query: local database only, and no ?host= override.
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (target.searchParams.has('host')) throw new Error('Refusing to run: DATABASE_URL has a "host" query parameter.');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, ''))) {
      throw new Error(`Refusing to run: database host "${target.hostname}" is not local.`);
    }

    const { query, withTransaction } = await import('$lib/server/db');
    const { applyCharacterEffect, removeCharacterEffect } = await import('./services/effects');
    const { createCharacter, restoreCharacterVersion } = await import('./services/characters');
    const { resolveCharacterModifierSources } = await import('./services/rule-engine');
    const tag = `zzeff${crypto.randomBytes(4).toString('hex')}`;
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Effects', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    try {
      const characterId = await createCharacter(userId, 'Effects');
      // A linked condition that refreshes, plus fixtures for stack / reject.
      const linked = (await query<{ id: string; name: string }>(
        `SELECT cd.id, cd.name FROM content_definitions cd WHERE cd.content_type='condition' AND NOT cd.is_archived
           AND cd.stack_behavior='refresh' AND EXISTS (SELECT 1 FROM content_modifier_links l WHERE l.content_id = cd.id) LIMIT 1`)).rows[0];
      expect(linked, 'needs a condition with modifier links').toBeTruthy();
      const mk = async (suffix: string, behaviour: string) => (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name, stack_behavior, duration_rounds)
         VALUES ($1, 'condition', $2, $3, 3) RETURNING id`, [`condition:${tag}${suffix}`, `IT ${suffix}`, behaviour])).rows[0].id;
      const stackId = await mk('stack', 'stack');
      const rejectId = await mk('reject', 'reject');
      const rows = (id: string) => query<any>(`SELECT * FROM active_character_effects WHERE character_id=$1 AND container_id=$2`, [characterId, id]);

      const apply = (id: string, options = {}) => withTransaction((client) => applyCharacterEffect(client, characterId, id, options));
      expect((await apply(linked.id)).status).toBe('applied');
      expect((await apply(linked.id, { remainingRounds: 5 })).status).toBe('refreshed');
      const active = await rows(linked.id);
      expect(active.rows).toHaveLength(1);
      expect(active.rows[0].effect_id).toBeNull();
      expect(active.rows[0].remaining_rounds).toBe(5);
      expect((await apply(linked.id)).effectId).toBe(linked.id);

      expect((await apply(stackId)).status).toBe('applied');
      expect((await apply(stackId)).status).toBe('stacked');
      expect((await rows(stackId)).rows).toHaveLength(2);
      expect((await apply(rejectId)).status).toBe('applied');
      expect((await apply(rejectId)).status).toBe('rejected');
      expect((await rows(rejectId)).rows).toHaveLength(1);
      await expect(apply(crypto.randomUUID())).rejects.toThrow('Effect is unavailable.');

      // The rule engine resolves the container's modifiers.
      const resolved = await resolveCharacterModifierSources(characterId);
      expect(resolved.audit.some((entry: any) => JSON.stringify(entry).includes(linked.name))).toBe(true);

      // Snapshot round-trip: the first version (no effects) is restored, which writes a "Before restore"
      // version holding the current effects, and that version is then restored back.
      const versions = async () => (await query<any>(`SELECT id, change_summary, snapshot_json FROM character_versions WHERE character_id=$1 ORDER BY created_at`, [characterId])).rows;
      const first = (await versions())[0];
      await restoreCharacterVersion(userId, characterId, first.id);
      expect((await query(`SELECT 1 FROM active_character_effects WHERE character_id=$1`, [characterId])).rows).toHaveLength(0);
      const before = (await versions()).find((v) => v.change_summary === 'Before restore');
      const keys = before.snapshot_json.active_effects.map((e: any) => e.effect_key);
      expect(keys).toContain(`${tag}stack`);
      expect(keys.every((k: string) => !k.startsWith('condition:'))).toBe(true); // unprefixed, as in old snapshots
      await restoreCharacterVersion(userId, characterId, before.id);
      expect((await rows(linked.id)).rows).toHaveLength(1);
      expect((await rows(stackId)).rows).toHaveLength(2);
      expect((await query<any>(`SELECT effect_id FROM active_character_effects WHERE character_id=$1`, [characterId])).rows.every((r) => r.effect_id === null)).toBe(true);

      // Remove by container id.
      expect(await withTransaction((client) => removeCharacterEffect(client, characterId, stackId))).toBe(2);
      expect((await rows(stackId)).rows).toHaveLength(0);
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      await query(`DELETE FROM content_definitions WHERE content_key LIKE $1`, [`condition:${tag}%`]);
    }
  });
  it('counts a condition once for the spell-slot bonus when it is both active and granted', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^[|]$/g, '')) || target.searchParams.has('host')) {
      throw new Error('Refusing to run: database is not local.');
    }
    const { query } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const { syncCharacterSpellSlots, listSpellSlots } = await import('./services/catalogue');
    const tag = `zzslot${crypto.randomBytes(4).toString('hex')}`;
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Slots', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    let modifierId = '';
    try {
      const characterId = await createCharacter(userId, 'Slots');
      await query(`DELETE FROM character_classes WHERE character_id=$1`, [characterId]);
      await query(`INSERT INTO character_classes (character_id, class_name, level, sort_order) VALUES ($1, 'Wizard', 5, 0)`, [characterId]);
      const top = async () => {
        await syncCharacterSpellSlots(userId, characterId);
        const slots = (await listSpellSlots(characterId)).filter((s) => s.type === 'standard');
        return slots[slots.length - 1].max;
      };
      const base = await top();

      modifierId = (await query<{ id: string }>(
        `INSERT INTO modifier_definitions (target, modifier_type, label, default_value_expression)
         VALUES ('spell_slots.highest.max', 'bonus', $1, '37') RETURNING id`, [tag])).rows[0].id;
      const conditionId = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1, 'condition', 'IT Slot Condition') RETURNING id`, [`condition:${tag}`])).rows[0].id;
      await query(`INSERT INTO content_modifier_links (content_id, modifier_id, activation_type) VALUES ($1, $2, 'carried')`, [conditionId, modifierId]);
      const itemId = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1, 'item', 'IT Slot Item') RETURNING id`, [`it:${tag}`])).rows[0].id;
      await query(`INSERT INTO content_grants (source_content_id, granted_content_id, activation_type) VALUES ($1, $2, 'equipped')`, [itemId, conditionId]);
      await query(`INSERT INTO character_inventory_items (character_id, name, category, quantity, equipped, source_content_id)
        VALUES ($1, 'IT Slot Item', 'gear', 1, true, $2)`, [characterId, itemId]);

      // Active only: counts once through the container path.
      await query(`INSERT INTO active_character_effects (character_id, container_id) VALUES ($1, $2)`, [characterId, conditionId]);
      expect(await top()).toBe(base + 37);
      // Active (twice) AND granted by the equipped item: still once.
      await query(`INSERT INTO active_character_effects (character_id, container_id) VALUES ($1, $2)`, [characterId, conditionId]);
      expect(await top()).toBe(base + 37);
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      await query(`DELETE FROM content_definitions WHERE content_key IN ($1, $2)`, [`condition:${tag}`, `it:${tag}`]);
      if (modifierId) await query(`DELETE FROM modifier_definitions WHERE id = $1`, [modifierId]);
    }
  });
  it('attaches, equips, detaches and uses condition grants (container ids only)', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, '')) || target.searchParams.has('host')) {
      throw new Error('Refusing to run: database is not local.');
    }
    const { query, withTransaction } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const { resolveCharacterModifierSources } = await import('./services/rule-engine');
    const { attachEffectToAdminContent, detachEffectFromAdminContent } = await import('./services/content-admin');
    const { executeContentActions } = await import('./services/action-engine');
    const tag = `zzgrant${crypto.randomBytes(4).toString('hex')}`;
    const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Grants', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    let itemId = '';
    try {
      const characterId = await createCharacter(userId, 'Grants');
      const modifierId = (await query<{ id: string }>(`SELECT id FROM modifier_definitions LIMIT 1`)).rows[0].id;
      const conditionId = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1, 'condition', $2) RETURNING id`, [`condition:${tag}`, `IT Grant ${tag}`])).rows[0].id;
      await query(`INSERT INTO content_modifier_links (content_id, modifier_id, activation_type) VALUES ($1, $2, 'carried')`, [conditionId, modifierId]);
      itemId = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1, 'item', 'IT Grant Item') RETURNING id`, [`it:${tag}`])).rows[0].id;
      const inv = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, category, quantity, equipped, source_content_id)
         VALUES ($1, 'IT Grant Item', 'gear', 1, false, $2) RETURNING id`, [characterId, itemId])).rows[0].id;
      const sourceNames = async () => (await resolveCharacterModifierSources(characterId)).audit.map((entry: any) => JSON.stringify(entry));
      const hasCondition = async () => (await sourceNames()).some((s) => s.includes(`IT Grant ${tag}`));

      // Attach as equipped writes a grant only; the engine applies it once the item is equipped.
      await attachEffectToAdminContent(form({ contentId: itemId, effectId: conditionId, activationType: 'equipped' }));
      const grants = await query<any>(`SELECT id FROM content_grants WHERE source_content_id=$1 AND granted_content_id=$2 AND activation_type='equipped'`, [itemId, conditionId]);
      expect(grants.rows).toHaveLength(1);
      expect((await query(`SELECT 1 FROM content_effect_links WHERE content_id=$1`, [itemId])).rows).toHaveLength(0);
      expect(await hasCondition()).toBe(false);
      await query(`UPDATE character_inventory_items SET equipped=true WHERE id=$1`, [inv]);
      expect(await hasCondition()).toBe(true);

      // Detach removes the grant, so the engine stops applying it.
      await detachEffectFromAdminContent(form({ contentId: itemId, linkId: grants.rows[0].id }));
      expect((await query(`SELECT 1 FROM content_grants WHERE source_content_id=$1`, [itemId])).rows).toHaveLength(0);
      expect(await hasCondition()).toBe(false);

      // on_use attach writes an action step carrying effect_container_id; using the item applies the condition.
      await attachEffectToAdminContent(form({ contentId: itemId, effectId: conditionId, activationType: 'on_use' }));
      const step = (await query<any>(`SELECT s.effect_id, s.effect_container_id FROM action_steps s
        JOIN content_action_links l ON l.action_container_id = s.container_id WHERE l.content_id=$1`, [itemId])).rows;
      expect(step).toEqual([{ effect_id: null, effect_container_id: conditionId }]);
      const results = await withTransaction((client) => executeContentActions(client, characterId, itemId, ['on_use'], { inventoryId: inv }));
      expect(results[0].detail).toBe('applied');
      expect((await query(`SELECT 1 FROM active_character_effects WHERE character_id=$1 AND container_id=$2`, [characterId, conditionId])).rows).toHaveLength(1);
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      await query(`DELETE FROM content_definitions WHERE content_key = $1`, [`it:${tag}`]); // cascades its action links
      if (itemId) await query(`DELETE FROM content_definitions WHERE content_type='action' AND content_key = $1`, [`action:content:${itemId}:on_use`]);
      await query(`DELETE FROM content_definitions WHERE content_key = $1`, [`condition:${tag}`]);
    }
  });
  it('authors conditions on containers only (rules admin)', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, '')) || target.searchParams.has('host')) {
      throw new Error('Refusing to run: database is not local.');
    }
    const { query, withTransaction } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const { applyCharacterEffect } = await import('./services/effects');
    const { saveEffect, attachEffectModifier, detachEffectModifier, archiveEffect, loadEffects, loadModifiers } = await import('./services/rules-admin');
    const tag = `zzauthor${crypto.randomBytes(4).toString('hex')}`;
    const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Author', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    const before = Number((await query<any>(`SELECT count(*)::int AS n FROM effect_definitions`)).rows[0].n);
    let id = '';
    try {
      id = await saveEffect(userId, form({ name: `IT Author ${tag}`, durationType: 'timed', durationRounds: '4', stackBehavior: 'refresh',
        expiryBoundary: 'turn_end', sourceType: 'homebrew', isCondition: 'on', isSelectable: 'on', description: 'authored' }));
      const row = (await query<any>(`SELECT * FROM content_definitions WHERE id=$1`, [id])).rows[0];
      expect(row.content_type).toBe('condition');
      expect(row.content_key.startsWith(`condition:homebrew:${userId}:`)).toBe(true);
      expect(row.duration_type).toBe('rounds');
      expect(row.metadata_json).toMatchObject({ isCondition: true, isSelectable: true, legacyDurationType: 'timed', isHomebrew: true });
      expect(Number((await query<any>(`SELECT count(*)::int AS n FROM effect_definitions`)).rows[0].n)).toBe(before);

      // Update keeps the container and round-trips the legacy duration.
      await saveEffect(userId, form({ effectId: id, name: `IT Author ${tag} b`, durationType: 'variable', stackBehavior: 'stack', expiryBoundary: 'round_end', sourceType: 'homebrew' }));
      let listed = (await loadEffects(id, tag)).effects.find((e: any) => e.id === id);
      expect(listed).toMatchObject({ durationType: 'variable', stackBehavior: 'stack', isCondition: false, isSelectable: false, referenceCount: 0, modifierCount: 0 });

      // Attach / detach a modifier, and the reference count comes from container links only.
      const modifierId = (await query<{ id: string }>(`SELECT id FROM modifier_definitions LIMIT 1`)).rows[0].id;
      const refsBefore = (await loadModifiers()).modifiers.find((m: any) => m.id === modifierId)!.referenceCount;
      await attachEffectModifier(form({ effectId: id, modifierId, priority: '2' }));
      const loaded = await loadEffects(id, tag);
      expect(loaded.effectLinks).toHaveLength(1);
      expect((await loadModifiers()).modifiers.find((m: any) => m.id === modifierId)!.referenceCount).toBe(refsBefore + 1);
      await detachEffectModifier(id, loaded.effectLinks[0].id);
      expect((await loadEffects(id, tag)).effectLinks).toHaveLength(0);

      // A grant to the condition shows as a reference; it applies to a character via the container id.
      const itemId = (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1, 'item', 'IT Author Item') RETURNING id`, [`it:${tag}`])).rows[0].id;
      await query(`INSERT INTO content_grants (source_content_id, granted_content_id, activation_type) VALUES ($1, $2, 'equipped')`, [itemId, id]);
      listed = (await loadEffects(id, tag)).effects.find((e: any) => e.id === id);
      expect(listed!.referenceCount).toBe(1);
      const characterId = await createCharacter(userId, 'Author');
      expect((await withTransaction((client) => applyCharacterEffect(client, characterId, id))).status).toBe('applied');

      // Archive hides it from the default list.
      await archiveEffect(id);
      expect((await loadEffects(id, tag)).effects.some((e: any) => e.id === id)).toBe(false);
      expect((await loadEffects(id, tag, true)).effects.some((e: any) => e.id === id)).toBe(true);
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      await query(`DELETE FROM content_definitions WHERE content_key = $1`, [`it:${tag}`]);
      if (id) await query(`DELETE FROM content_definitions WHERE id = $1`, [id]);
    }
  });
  it('writes actions as containers: admin step, use, spend_item and no duplicate attach', async () => {
    const target = new URL(env.DATABASE_URL ?? 'postgres://none@none/none');
    if (!['localhost', '127.0.0.1', '::1'].includes(target.hostname.replace(/^\[|\]$/g, '')) || target.searchParams.has('host')) {
      throw new Error('Refusing to run: database is not local.');
    }
    const { query } = await import('$lib/server/db');
    const { createCharacter } = await import('./services/characters');
    const { useInventoryCatalogueItem } = await import('./services/catalogue');
    const { addContentResourceAction, attachActionToContent, attachEffectToAdminContent } = await import('./services/content-admin');
    const tag = `zzact${crypto.randomBytes(4).toString('hex')}`;
    const form = (values: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(values)) f.set(k, v); return f; };
    const userId = (await query<{ id: string }>(
      `INSERT INTO users (email, display_name, password_hash) VALUES ($1, 'IT Actions', 'x') RETURNING id`, [`${tag}@example.invalid`])).rows[0].id;
    const actionKeys: string[] = [];
    const itemKeys = [`it:${tag}a`, `it:${tag}b`];
    try {
      const characterId = await createCharacter(userId, 'Actions');
      const mkItem = async (key: string) => (await query<{ id: string }>(
        `INSERT INTO content_definitions (content_key, content_type, name) VALUES ($1, 'item', $2) RETURNING id`, [key, `IT ${key}`])).rows[0].id;
      const itemA = await mkItem(itemKeys[0]);
      const itemB = await mkItem(itemKeys[1]);
      actionKeys.push(`action:content:${itemA}:on_use`);
      const inv = (await query<{ id: string }>(
        `INSERT INTO character_inventory_items (character_id, name, category, quantity, source_content_id)
         VALUES ($1, 'IT Potion', 'gear', 3, $2) RETURNING id`, [characterId, itemA])).rows[0].id;

      // Admin adds a spend_item step: container + link + step, no legacy rows.
      await addContentResourceAction(form({ contentId: itemA, activationType: 'on_use', stepType: 'spend_item', valueExpression: '1', actionLabel: 'Drink' }));
      const links = (await query<any>(`SELECT action_id, action_container_id FROM content_action_links WHERE content_id=$1`, [itemA])).rows;
      expect(links).toHaveLength(1);
      expect(links[0].action_id).toBeNull();
      const container = links[0].action_container_id as string;
      expect((await query<any>(`SELECT content_key FROM content_definitions WHERE id=$1`, [container])).rows[0].content_key).toBe(`action:content:${itemA}:on_use`);
      const steps = (await query<any>(`SELECT action_id, container_id, step_type FROM action_steps WHERE container_id=$1`, [container])).rows;
      expect(steps).toEqual([{ action_id: null, container_id: container, step_type: 'spend_item' }]);
      expect((await query(`SELECT 1 FROM action_definitions WHERE action_key LIKE $1`, [`%${itemA}%`])).rows).toHaveLength(0);

      // A second step reuses the same container (no new action).
      await addContentResourceAction(form({ contentId: itemA, activationType: 'on_use', stepType: 'resource_change', actionOperation: 'add', targetType: 'hp', targetKey: '', valueExpression: '1' }));
      expect((await query(`SELECT 1 FROM content_action_links WHERE content_id=$1`, [itemA])).rows).toHaveLength(1);
      expect((await query(`SELECT 1 FROM action_steps WHERE container_id=$1`, [container])).rows).toHaveLength(2);

      // Using the item runs the steps, and spend_item suppresses the default decrement (3 -> 2, not 1).
      await useInventoryCatalogueItem(userId, characterId, inv);
      expect((await query<any>(`SELECT quantity FROM character_inventory_items WHERE id=$1`, [inv])).rows[0].quantity).toBe(2);

      // Attaching the same action twice does not duplicate the link.
      await attachActionToContent(form({ contentId: itemB, actionId: container, triggerType: 'on_use' }));
      await attachActionToContent(form({ contentId: itemB, actionId: container, triggerType: 'on_use' }));
      expect((await query(`SELECT 1 FROM content_action_links WHERE content_id=$1`, [itemB])).rows).toHaveLength(1);

      // An on_use condition attach on the same item reuses the container and dedupes its step.
      const conditionId = (await query<{ id: string }>(`SELECT id FROM content_definitions WHERE content_type='condition' AND NOT is_archived LIMIT 1`)).rows[0].id;
      await attachEffectToAdminContent(form({ contentId: itemA, effectId: conditionId, activationType: 'on_use' }));
      await attachEffectToAdminContent(form({ contentId: itemA, effectId: conditionId, activationType: 'on_use' }));
      expect((await query(`SELECT 1 FROM content_action_links WHERE content_id=$1`, [itemA])).rows).toHaveLength(1);
      expect((await query(`SELECT 1 FROM action_steps WHERE container_id=$1 AND step_type='apply_effect'`, [container])).rows).toHaveLength(1);
    } finally {
      await query(`DELETE FROM users WHERE id = $1`, [userId]);
      await query(`DELETE FROM content_definitions WHERE content_key = ANY($1::text[])`, [itemKeys]); // cascades links
      await query(`DELETE FROM content_definitions WHERE content_type='action' AND content_key = ANY($1::text[])`, [actionKeys]);
    }
  });
});
