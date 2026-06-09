import { query, withTransaction } from '$lib/server/db';

export const modifierTargets = [
  ['ac', 'Armor Class'],
  ['ac_formula', 'AC Formula'],
  ['initiative', 'Initiative'],
  ['attack_roll.all', 'Attack Rolls'],
  ['attack_roll.weapon', 'Weapon Attack Rolls'],
  ['attack_roll.melee_weapon', 'Melee Weapon Attack Rolls'],
  ['attack_roll.ranged_weapon', 'Ranged Weapon Attack Rolls'],
  ['attack_roll.spell', 'Spell Attack Rolls'],
  ['damage_roll.all', 'Damage Rolls'],
  ['damage_roll.weapon', 'Weapon Damage Rolls'],
  ['damage_roll.melee_weapon.str', 'STR Melee Weapon Damage'],
  ['saving_throw.all', 'Saving Throws'],
  ['saving_throw.str', 'Strength Saving Throws'],
  ['saving_throw.dex', 'Dexterity Saving Throws'],
  ['ability_check.all', 'Ability Checks'],
  ['ability_check.str', 'Strength Ability Checks'],
  ['speed.all', 'Speed'],
  ['action.standard', 'Standard Action'],
  ['action.reaction', 'Reaction'],
  ['spellcasting', 'Spellcasting'],
  ['concentration', 'Concentration'],
  ['damage_taken.bludgeoning', 'Bludgeoning Damage Taken'],
  ['damage_taken.piercing', 'Piercing Damage Taken'],
  ['damage_taken.slashing', 'Slashing Damage Taken'],
  ['visibility.targeting', 'Targeting / Visibility']
] as const;

export const modifierTypes = [
  ['bonus', 'Bonus'],
  ['penalty', 'Penalty'],
  ['set', 'Set Value'],
  ['multiplier', 'Multiplier'],
  ['advantage', 'Advantage'],
  ['disadvantage', 'Disadvantage'],
  ['extra_die', 'Extra Die'],
  ['resistance', 'Resistance'],
  ['vulnerability', 'Vulnerability'],
  ['immunity', 'Immunity'],
  ['grant', 'Grant'],
  ['block', 'Block'],
  ['condition_apply', 'Apply Condition'],
  ['condition_remove', 'Remove Condition'],
  ['formula_override', 'Formula Override']
] as const;

export type AdminEffect = {
  id: string;
  key: string;
  name: string;
  sourceType: string;
  sourceRef: string;
  description: string;
  isSelectable: boolean;
  isHomebrew: boolean;
  modifierCount: number;
};

export type AdminModifier = {
  id: string;
  target: string;
  modifierType: string;
  defaultValueExpression: string;
  label: string;
  description: string;
};

export type AdminEffectLink = {
  id: string;
  effectId: string;
  modifierId: string;
  target: string;
  modifierType: string;
  defaultValueExpression: string;
  valueOverrideExpression: string;
  resolvedValueExpression: string;
  conditionExpression: string;
  priority: number;
};

export function targetLabel(target: string): string {
  return modifierTargets.find(([key]) => key === target)?.[1] ?? target;
}

export function typeLabel(type: string): string {
  return modifierTypes.find(([key]) => key === type)?.[1] ?? type;
}

export async function loadModifierAdmin(selectedEffectId = '') {
  const effects = await query<{
    id: string;
    effect_key: string;
    name: string;
    source_type: string;
    source_ref: string;
    description: string;
    is_selectable: boolean;
    is_homebrew: boolean;
    modifier_count: string;
  }>(
    `
      SELECT
        effect_definitions.id,
        effect_definitions.effect_key,
        effect_definitions.name,
        effect_definitions.source_type,
        COALESCE(effect_definitions.source_ref, '') AS source_ref,
        COALESCE(effect_definitions.description, '') AS description,
        COALESCE(effect_definitions.is_selectable, true) AS is_selectable,
        COALESCE(effect_definitions.is_homebrew, false) AS is_homebrew,
        COUNT(effect_modifier_links.id) AS modifier_count
      FROM effect_definitions
      LEFT JOIN effect_modifier_links ON effect_modifier_links.effect_id = effect_definitions.id
      GROUP BY effect_definitions.id
      ORDER BY effect_definitions.is_selectable DESC, effect_definitions.name ASC
    `
  );

  const modifiers = await query<{
    id: string;
    target: string;
    modifier_type: string;
    default_value_expression: string;
    label: string;
    description: string;
  }>(
    `
      SELECT id, target, modifier_type, COALESCE(default_value_expression, '') AS default_value_expression, COALESCE(label, '') AS label, COALESCE(description, '') AS description
      FROM modifier_definitions
      ORDER BY target ASC, modifier_type ASC, default_value_expression ASC
    `
  );

  const selectedEffect = selectedEffectId || effects.rows[0]?.id || '';
  const links = selectedEffect
    ? await query<{
        id: string;
        effect_id: string;
        modifier_id: string;
        target: string;
        modifier_type: string;
        default_value_expression: string;
        value_override_expression: string;
        resolved_value_expression: string;
        condition_expression: string;
        priority: number;
      }>(
        `
          SELECT
            effect_modifier_links.id,
            effect_modifier_links.effect_id,
            effect_modifier_links.modifier_id,
            modifier_definitions.target,
            modifier_definitions.modifier_type,
            COALESCE(modifier_definitions.default_value_expression, '') AS default_value_expression,
            COALESCE(effect_modifier_links.value_override_expression, '') AS value_override_expression,
            COALESCE(effect_modifier_links.value_override_expression, modifier_definitions.default_value_expression, '') AS resolved_value_expression,
            COALESCE(effect_modifier_links.condition_expression, '') AS condition_expression,
            effect_modifier_links.priority
          FROM effect_modifier_links
          JOIN modifier_definitions ON modifier_definitions.id = effect_modifier_links.modifier_id
          WHERE effect_modifier_links.effect_id = $1
          ORDER BY effect_modifier_links.priority ASC, modifier_definitions.target ASC
        `,
        [selectedEffect]
      )
    : { rows: [] };

  return {
    effects: effects.rows.map((row): AdminEffect => ({
      id: row.id,
      key: row.effect_key,
      name: row.name,
      sourceType: row.source_type,
      sourceRef: row.source_ref,
      description: row.description,
      isSelectable: row.is_selectable,
      isHomebrew: row.is_homebrew,
      modifierCount: Number(row.modifier_count) || 0
    })),
    modifiers: modifiers.rows.map((row): AdminModifier => ({
      id: row.id,
      target: row.target,
      modifierType: row.modifier_type,
      defaultValueExpression: row.default_value_expression,
      label: row.label,
      description: row.description
    })),
    links: links.rows.map((row): AdminEffectLink => ({
      id: row.id,
      effectId: row.effect_id,
      modifierId: row.modifier_id,
      target: row.target,
      modifierType: row.modifier_type,
      defaultValueExpression: row.default_value_expression,
      valueOverrideExpression: row.value_override_expression,
      resolvedValueExpression: row.resolved_value_expression,
      conditionExpression: row.condition_expression,
      priority: row.priority
    })),
    selectedEffect
  };
}

export async function updateEffect(form: FormData): Promise<string> {
  const effectId = String(form.get('effectId') || '');
  if (!effectId) throw new Error('Effect is required.');

  await query(
    `
      UPDATE effect_definitions
      SET name = $1,
          description = $2,
          is_selectable = $3,
          metadata_json = metadata_json || $4::jsonb
      WHERE id = $5
    `,
    [
      String(form.get('name') || '').trim() || 'Unnamed Effect',
      String(form.get('description') || '').trim(),
      form.get('isSelectable') === 'on',
      JSON.stringify({ adminUpdatedAt: new Date().toISOString() }),
      effectId
    ]
  );

  return effectId;
}

export async function createEffect(userId: string, form: FormData): Promise<string> {
  const name = String(form.get('name') || '').trim();
  if (!name) throw new Error('Effect name is required.');

  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80) || 'custom_effect';
  const key = `custom:${userId}:${slug}`;
  const sourceType = String(form.get('sourceType') || 'homebrew').trim() || 'homebrew';

  const result = await query<{ id: string }>(
    `
      INSERT INTO effect_definitions (
        effect_key, name, source_type, source_ref, description, duration_type,
        requires_concentration, is_condition, is_selectable, is_homebrew, owner_user_id, metadata_json
      )
      VALUES ($1, $2, $3, $4, $5, $6, false, false, true, true, $7, $8)
      ON CONFLICT (effect_key) DO UPDATE
      SET name = EXCLUDED.name,
          source_type = EXCLUDED.source_type,
          source_ref = EXCLUDED.source_ref,
          description = EXCLUDED.description,
          is_selectable = true,
          is_homebrew = true,
          owner_user_id = EXCLUDED.owner_user_id
      RETURNING id
    `,
    [
      key,
      name,
      sourceType,
      `custom.${slug}`,
      String(form.get('description') || '').trim(),
      String(form.get('durationType') || 'variable').trim() || 'variable',
      userId,
      JSON.stringify({ createdFromAdmin: true })
    ]
  );

  const effectId = result.rows[0].id;
  await query(
    `
      INSERT INTO effect_sources (effect_id, source_type, source_ref, source_name, is_homebrew, owner_user_id)
      VALUES ($1, $2, $3, $4, true, $5)
      ON CONFLICT (effect_id, source_ref) DO UPDATE
      SET source_name = EXCLUDED.source_name
    `,
    [effectId, sourceType, `custom.${slug}`, name, userId]
  );

  return effectId;
}

export async function createModifier(form: FormData): Promise<string> {
  const target = String(form.get('target') || '').trim();
  const modifierType = String(form.get('modifierType') || '').trim();
  if (!target || !modifierType) throw new Error('Target and modifier type are required.');

  const result = await query<{ id: string }>(
    `
      INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, label, description)
      VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), NULLIF($5, ''))
      ON CONFLICT (target, modifier_type, COALESCE(default_value_expression, '')) DO UPDATE
      SET label = COALESCE(EXCLUDED.label, modifier_definitions.label),
          description = COALESCE(EXCLUDED.description, modifier_definitions.description)
      RETURNING id
    `,
    [
      target,
      modifierType,
      String(form.get('defaultValueExpression') || '').trim(),
      String(form.get('label') || '').trim(),
      String(form.get('description') || '').trim()
    ]
  );

  return result.rows[0].id;
}

export async function attachModifierToEffect(form: FormData): Promise<string> {
  const effectId = String(form.get('effectId') || '');
  const modifierId = String(form.get('modifierId') || '');
  if (!effectId || !modifierId) throw new Error('Effect and modifier are required.');

  await query(
    `
      INSERT INTO effect_modifier_links (effect_id, modifier_id, value_override_expression, condition_expression, priority)
      VALUES ($1, $2, NULLIF($3, ''), NULLIF($4, ''), $5)
      ON CONFLICT (
        effect_id,
        modifier_id,
        COALESCE(value_override_expression, ''),
        COALESCE(condition_expression, ''),
        priority
      ) DO NOTHING
    `,
    [
      effectId,
      modifierId,
      String(form.get('valueOverrideExpression') || '').trim(),
      String(form.get('conditionExpression') || '').trim(),
      Number(form.get('priority')) || 0
    ]
  );

  return effectId;
}

export async function detachModifierFromEffect(form: FormData): Promise<string> {
  const effectId = String(form.get('effectId') || '');
  const linkId = String(form.get('linkId') || '');
  if (!linkId) throw new Error('Link is required.');

  await query('DELETE FROM effect_modifier_links WHERE id = $1', [linkId]);
  return effectId;
}

export async function seedCoreEffects(): Promise<void> {
  const effects = [
    {
      key: 'condition_poisoned',
      name: 'Poisoned',
      sourceType: 'condition',
      sourceRef: 'condition.poisoned',
      description: 'Disadvantage on attack rolls and ability checks.',
      durationType: 'variable',
      isCondition: true,
      sortOrder: 100,
      modifiers: [
        ['attack_roll.all', 'disadvantage', null],
        ['ability_check.all', 'disadvantage', null]
      ]
    },
    {
      key: 'rage',
      name: 'Rage',
      sourceType: 'class_feature',
      sourceRef: 'barbarian.rage',
      description: 'Advantage on STR checks/saves, melee STR damage bonus, B/P/S resistance, blocks spellcasting.',
      durationType: 'timed',
      isCondition: false,
      sortOrder: 200,
      modifiers: [
        ['ability_check.str', 'advantage', null],
        ['saving_throw.str', 'advantage', null],
        ['damage_roll.melee_weapon.str', 'bonus', 'rage_damage_bonus'],
        ['damage_taken.bludgeoning', 'resistance', null],
        ['damage_taken.piercing', 'resistance', null],
        ['damage_taken.slashing', 'resistance', null],
        ['spellcasting', 'block', null],
        ['concentration', 'block', null]
      ]
    },
    {
      key: 'bless',
      name: 'Bless',
      sourceType: 'spell',
      sourceRef: 'spell.bless',
      description: 'Add 1d4 to attack rolls and saving throws.',
      durationType: 'concentration',
      isCondition: false,
      sortOrder: 210,
      modifiers: [
        ['attack_roll.all', 'extra_die', '1d4'],
        ['saving_throw.all', 'extra_die', '1d4']
      ]
    },
    {
      key: 'haste',
      name: 'Haste',
      sourceType: 'spell',
      sourceRef: 'spell.haste',
      description: 'Double speed, +2 AC, advantage on DEX saves, restricted extra action.',
      durationType: 'concentration',
      isCondition: false,
      sortOrder: 220,
      modifiers: [
        ['speed.all', 'multiplier', '2'],
        ['ac', 'bonus', '2'],
        ['saving_throw.dex', 'advantage', null],
        ['action.extra.haste', 'grant', 'attack_one_weapon_attack,dash,disengage,hide,use_object']
      ]
    },
    {
      key: 'shield_spell',
      name: 'Shield',
      sourceType: 'spell',
      sourceRef: 'spell.shield',
      description: '+5 AC until start of next turn and immunity to Magic Missile.',
      durationType: 'until_start_of_next_turn',
      isCondition: false,
      sortOrder: 230,
      modifiers: [
        ['ac', 'bonus', '5'],
        ['spell.magic_missile', 'immunity', null]
      ]
    },
    {
      key: 'dodge',
      name: 'Dodge',
      sourceType: 'combat_state',
      sourceRef: 'action.dodge',
      description: 'Attacks against have disadvantage; advantage on DEX saves.',
      durationType: 'until_start_of_next_turn',
      isCondition: false,
      sortOrder: 300,
      modifiers: [['saving_throw.dex', 'advantage', null]]
    },
    {
      key: 'half_cover',
      name: 'Half Cover',
      sourceType: 'environment',
      sourceRef: 'cover.half',
      description: '+2 AC and +2 DEX saves.',
      durationType: 'while_applicable',
      isCondition: false,
      sortOrder: 310,
      modifiers: [
        ['ac', 'bonus', '2'],
        ['saving_throw.dex', 'bonus', '2']
      ]
    },
    {
      key: 'three_quarters_cover',
      name: 'Three-Quarters Cover',
      sourceType: 'environment',
      sourceRef: 'cover.three_quarters',
      description: '+5 AC and +5 DEX saves.',
      durationType: 'while_applicable',
      isCondition: false,
      sortOrder: 320,
      modifiers: [
        ['ac', 'bonus', '5'],
        ['saving_throw.dex', 'bonus', '5']
      ]
    }
  ] as const;

  await withTransaction(async (client) => {
    for (const effect of effects) {
      const effectResult = await client.query<{ id: string }>(
        `
          INSERT INTO effect_definitions (
            effect_key, name, source_type, source_ref, description, duration_type,
            requires_concentration, is_condition, is_selectable, sort_order
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)
          ON CONFLICT (effect_key) DO UPDATE
          SET name = EXCLUDED.name,
              source_type = EXCLUDED.source_type,
              source_ref = EXCLUDED.source_ref,
              description = EXCLUDED.description,
              duration_type = EXCLUDED.duration_type,
              requires_concentration = EXCLUDED.requires_concentration,
              is_condition = EXCLUDED.is_condition,
              is_selectable = true,
              sort_order = EXCLUDED.sort_order
          RETURNING id
        `,
        [
          effect.key,
          effect.name,
          effect.sourceType,
          effect.sourceRef,
          effect.description,
          effect.durationType,
          effect.durationType === 'concentration',
          effect.isCondition,
          effect.sortOrder
        ]
      );
      const effectId = effectResult.rows[0].id;

      await client.query(
        `
          INSERT INTO effect_sources (effect_id, source_type, source_ref, source_name)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT (effect_id, source_ref) DO UPDATE
          SET source_name = EXCLUDED.source_name
        `,
        [effectId, effect.sourceType, effect.sourceRef, effect.name]
      );

      for (const [target, modifierType, value] of effect.modifiers) {
        const modifier = await client.query<{ id: string }>(
          `
            INSERT INTO modifier_definitions (target, modifier_type, default_value_expression)
            VALUES ($1, $2, $3)
            ON CONFLICT (target, modifier_type, COALESCE(default_value_expression, '')) DO UPDATE
            SET target = EXCLUDED.target
            RETURNING id
          `,
          [target, modifierType, value]
        );

        await client.query(
          `
            INSERT INTO effect_modifier_links (effect_id, modifier_id)
            VALUES ($1, $2)
            ON CONFLICT (
              effect_id,
              modifier_id,
              COALESCE(value_override_expression, ''),
              COALESCE(condition_expression, ''),
              priority
            ) DO NOTHING
          `,
          [effectId, modifier.rows[0].id]
        );
      }
    }
  });
}
