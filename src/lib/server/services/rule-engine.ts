import { query } from '$lib/server/db';
import type { ActiveCharacterEffect, EffectModifier } from '$lib/types/character';
import type { ResolvedModifier } from '$lib/types/rules';

type ModifierRow = {
  source_id: string;
  source_type: 'effect' | 'content' | 'item' | 'grant';
  source_name: string;
  source_description: string;
  attachment_id: string;
  modifier_id: string;
  target: string;
  modifier_type: string;
  modifier_label: string;
  value_expression: string;
  default_value_expression: string;
  value_override_expression: string;
  condition_expression: string;
  priority: number;
  runtime_supported: boolean;
};

export async function resolveCharacterModifierSources(characterId: string): Promise<{
  sources: ActiveCharacterEffect[];
  audit: ResolvedModifier[];
}> {
  const result = await query<ModifierRow>(`
    WITH modifier_rows AS (
      -- Branch 1a: active effects resolved via unified Container (container_id path)
      SELECT active.id::text AS source_id, 'effect'::text AS source_type,
        container.name AS source_name,
        COALESCE(container.description, '') AS source_description,
        link.id::text AS attachment_id,
        modifier.id::text AS modifier_id, modifier.target, modifier.modifier_type,
        COALESCE(modifier.label, '') AS modifier_label,
        COALESCE(link.value_override_expression, modifier.default_value_expression, '') AS value_expression,
        COALESCE(modifier.default_value_expression, '') AS default_value_expression,
        COALESCE(link.value_override_expression, '') AS value_override_expression,
        COALESCE(link.condition_expression, '') AS condition_expression, link.priority,
        COALESCE(hook.runtime_supported, false) AS runtime_supported
      FROM active_character_effects active
      JOIN content_definitions container ON container.id = active.container_id
      JOIN content_modifier_links link ON link.content_id = container.id
      JOIN modifier_definitions modifier ON modifier.id = link.modifier_id
      LEFT JOIN modifier_targets hook ON hook.target_key = modifier.target
      WHERE active.character_id = $1

      UNION ALL

      -- Branch 1b: active effects legacy path (rows not yet back-filled with container_id)
      SELECT active.id::text, 'effect', effect.name,
        COALESCE(effect.description, ''), link.id::text, modifier.id::text,
        modifier.target, modifier.modifier_type, COALESCE(modifier.label, ''),
        COALESCE(link.value_override_expression, modifier.default_value_expression, ''),
        COALESCE(modifier.default_value_expression, ''), COALESCE(link.value_override_expression, ''),
        COALESCE(link.condition_expression, ''), link.priority, COALESCE(hook.runtime_supported, false)
      FROM active_character_effects active
      JOIN effect_definitions effect ON effect.id = active.effect_id
      JOIN effect_modifier_links link ON link.effect_id = effect.id
      JOIN modifier_definitions modifier ON modifier.id = link.modifier_id
      LEFT JOIN modifier_targets hook ON hook.target_key = modifier.target
      WHERE active.character_id = $1 AND active.container_id IS NULL

      UNION ALL

      SELECT instance.id::text, 'content', COALESCE(instance.custom_name, content.name), content.description,
        link.id::text, modifier.id::text, modifier.target, modifier.modifier_type, COALESCE(modifier.label, ''),
        COALESCE(link.value_override_expression, modifier.default_value_expression, ''),
        COALESCE(modifier.default_value_expression, ''), COALESCE(link.value_override_expression, ''),
        COALESCE(link.condition_expression, ''), link.priority, COALESCE(hook.runtime_supported, false)
      FROM character_content_instances instance
      JOIN content_definitions content ON content.id = instance.content_id
      JOIN content_modifier_links link ON link.content_id = content.id
      JOIN modifier_definitions modifier ON modifier.id = link.modifier_id
      LEFT JOIN modifier_targets hook ON hook.target_key = modifier.target
      WHERE instance.character_id = $1 AND instance.is_active = true AND content.content_type <> 'item'
        AND (link.activation_type = 'manual'
          OR (link.activation_type = 'known' AND instance.is_known)
          OR (link.activation_type = 'prepared' AND instance.is_prepared))

      UNION ALL

      SELECT inventory.id::text, 'item', inventory.name, inventory.notes, link.id::text,
        modifier.id::text, modifier.target, modifier.modifier_type, COALESCE(modifier.label, ''),
        COALESCE(link.value_override_expression, modifier.default_value_expression, ''),
        COALESCE(modifier.default_value_expression, ''), COALESCE(link.value_override_expression, ''),
        COALESCE(link.condition_expression, ''), link.priority, COALESCE(hook.runtime_supported, false)
      FROM character_inventory_items inventory
      JOIN content_modifier_links link ON link.content_id = inventory.source_content_id
      JOIN modifier_definitions modifier ON modifier.id = link.modifier_id
      LEFT JOIN modifier_targets hook ON hook.target_key = modifier.target
      WHERE inventory.character_id = $1 AND (
        link.activation_type = 'carried'
        OR (link.activation_type = 'equipped' AND inventory.equipped)
        OR (link.activation_type = 'attuned' AND inventory.attuned)
      )

      UNION ALL

      SELECT inventory.id::text || ':' || granted.id::text, 'grant', granted.name, granted.description,
        link.id::text, modifier.id::text, modifier.target, modifier.modifier_type, COALESCE(modifier.label, ''),
        COALESCE(link.value_override_expression, modifier.default_value_expression, ''),
        COALESCE(modifier.default_value_expression, ''), COALESCE(link.value_override_expression, ''),
        COALESCE(link.condition_expression, ''), link.priority, COALESCE(hook.runtime_supported, false)
      FROM character_inventory_items inventory
      JOIN content_grants grant_link ON grant_link.source_content_id = inventory.source_content_id
      JOIN content_definitions granted ON granted.id = grant_link.granted_content_id
      JOIN content_modifier_links link ON link.content_id = granted.id
      JOIN modifier_definitions modifier ON modifier.id = link.modifier_id
      LEFT JOIN modifier_targets hook ON hook.target_key = modifier.target
      WHERE inventory.character_id = $1 AND (
        grant_link.activation_type = 'carried'
        OR (grant_link.activation_type = 'equipped' AND inventory.equipped)
        OR (grant_link.activation_type = 'attuned' AND inventory.attuned)
      )
    )
    SELECT * FROM modifier_rows ORDER BY priority, source_name, target
  `, [characterId]);

  const grouped = new Map<string, ActiveCharacterEffect>();
  for (const row of result.rows) {
    const key = `${row.source_type}:${row.source_id}`;
    const source = grouped.get(key) ?? {
      id: key,
      effectId: '', effectKey: key, name: row.source_name, sourceType: row.source_type,
      sourceName: row.source_name, description: row.source_description, durationType: 'while_applicable',
      requiresConcentration: false, isCondition: false, isSelectable: false, remainingRounds: null, modifiers: []
    };
    source.modifiers.push(mapModifier(row));
    grouped.set(key, source);
  }

  return {
    sources: [...grouped.values()],
    audit: result.rows.map((row) => ({
      sourceId: row.source_id, sourceType: row.source_type, sourceName: row.source_name,
      attachmentId: row.attachment_id, modifierId: row.modifier_id, target: row.target,
      operation: row.modifier_type as ResolvedModifier['operation'], valueExpression: row.value_expression,
      conditionExpression: row.condition_expression, priority: row.priority,
      runtimeSupported: row.runtime_supported
    }))
  };
}

function mapModifier(row: ModifierRow): EffectModifier {
  return {
    target: row.target, modifierType: row.modifier_type, label: row.modifier_label, valueExpression: row.value_expression,
    defaultValueExpression: row.default_value_expression, valueOverrideExpression: row.value_override_expression,
    conditionExpression: row.condition_expression, priority: row.priority
  };
}
