import { query } from '$lib/server/db';
import { cachedReference } from '$lib/server/cache/referenceData';
import type { ActiveCharacterEffect } from '$lib/types/character';

// The VTT stores a token's status conditions as plain lowercase keys ('poisoned', 'prone', ...)
// that live only in the VTT's in-memory store. The mechanics for those conditions live on the
// shared condition Containers (content_definitions, type 'condition'), so this maps each VTT key to
// the Container content key(s) that carry them. The first key that exists wins, which is how the
// 'paralyzed' / 'paralysed' duplicate Containers are handled.
//
// Only conditions with advantage-relevant mechanics matter to attack rolls, but the full VTT list
// is mapped so a DM adding a modifier to (say) Charmed in the admin is picked up with no code change.
const VTT_CONDITION_CONTAINERS: Record<string, string[]> = {
  blinded: ['condition:condition_blinded'],
  charmed: ['condition:condition_charmed'],
  deafened: ['condition:condition_deafened'],
  exhaustion: ['condition:condition_exhaustion'],
  frightened: ['condition:condition_frightened'],
  grappled: ['condition:condition_grappled'],
  incapacitated: ['condition:condition_incapacitated'],
  invisible: ['condition:condition_invisible'],
  paralyzed: ['condition:condition_paralyzed', 'condition:condition_paralysed'],
  petrified: ['condition:condition_petrified'],
  poisoned: ['condition:condition_poisoned'],
  prone: ['condition:condition_prone'],
  restrained: ['condition:condition_restrained'],
  stunned: ['condition:condition_stunned'],
  unconscious: ['condition:condition_unconscious']
};

type ConditionRow = {
  content_key: string;
  name: string;
  target: string;
  modifier_type: string;
  label: string;
  value_expression: string;
  default_value_expression: string;
  value_override_expression: string;
  condition_expression: string;
  priority: number;
};

// Returns one synthetic ActiveCharacterEffect per VTT condition key, built from the live condition
// Container's modifier links. Cached as reference data (admin-edited only, never per-character).
// The effect id is deterministic so an advantage source id stays the same between preview and roll.
export function loadVttConditionEffects(): Promise<Map<string, ActiveCharacterEffect>> {
  return cachedReference('vtt-condition-effects', async () => {
    const allKeys = Object.values(VTT_CONDITION_CONTAINERS).flat();
    const result = await query<ConditionRow>(`
      SELECT container.content_key, container.name, modifier.target, modifier.modifier_type,
        COALESCE(modifier.label, '') AS label,
        COALESCE(link.value_override_expression, modifier.default_value_expression, '') AS value_expression,
        COALESCE(modifier.default_value_expression, '') AS default_value_expression,
        COALESCE(link.value_override_expression, '') AS value_override_expression,
        COALESCE(link.condition_expression, '') AS condition_expression,
        link.priority
      FROM content_definitions container
      JOIN content_modifier_links link ON link.content_id = container.id
      JOIN modifier_definitions modifier ON modifier.id = link.modifier_id
      WHERE container.content_key = ANY($1) AND container.content_type = 'condition'
        AND container.owner_user_id IS NULL AND NOT container.is_archived AND NOT modifier.is_archived
      ORDER BY link.priority, link.sort_order, modifier.target
    `, [allKeys]);

    const byContainer = new Map<string, ConditionRow[]>();
    for (const row of result.rows) byContainer.set(row.content_key, [...(byContainer.get(row.content_key) ?? []), row]);

    const effects = new Map<string, ActiveCharacterEffect>();
    for (const [vttKey, contentKeys] of Object.entries(VTT_CONDITION_CONTAINERS)) {
      // First content key that exists (has at least one modifier row) wins.
      const contentKey = contentKeys.find((key) => byContainer.has(key));
      if (!contentKey) continue;
      const rows = byContainer.get(contentKey)!;
      effects.set(vttKey, {
        id: `vtt-condition:${vttKey}`,
        effectId: '',
        effectKey: contentKey,
        containerKey: contentKey,
        name: rows[0].name,
        sourceType: 'condition',
        sourceName: rows[0].name,
        description: '',
        durationType: 'while_applicable',
        requiresConcentration: false,
        isCondition: true,
        isSelectable: false,
        remainingRounds: null,
        modifiers: rows.map((row) => ({
          target: row.target,
          modifierType: row.modifier_type,
          label: row.label,
          valueExpression: row.value_expression,
          defaultValueExpression: row.default_value_expression,
          valueOverrideExpression: row.value_override_expression,
          conditionExpression: row.condition_expression,
          priority: row.priority
        }))
      });
    }
    return effects;
  });
}
