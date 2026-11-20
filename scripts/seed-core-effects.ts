import pg from 'pg';
import './load-env';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

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

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
    await client.query('COMMIT');
    console.log(`seeded ${effects.length} core effects`);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
