import pg from 'pg';
import './load-env';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required.');
}
const characterName = process.env.TEST_CHARACTER_NAME || 'Newton';

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: 5,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined
});

// Fixture for docs/architecture/modifier-primacy.md §6.4 (outcome-gated roll resolution) and
// §2.1 (sibling-derived Modifier values). A single Container (this weapon) with two Modifiers
// attached directly to it: a base damage die, and a crit bonus that reads that same die's own
// max via the sibling-derived value source, gated on the 'critical_hit' outcome.
const weaponTarget = 'damage_roll.melee_weapon.str';

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const content = await client.query<{ id: string }>(
      `
        INSERT INTO content_definitions (content_key, content_type, name, description, source_kind)
        VALUES ($1, 'item', $2, $3, 'homebrew')
        ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO UPDATE
        SET name = EXCLUDED.name, description = EXCLUDED.description
        RETURNING id
      `,
      [
        'homebrew:item:flameheart_greatsword',
        'Flameheart Greatsword',
        'A greatsword whose blade catches fire on a solid hit. Test fixture for outcome-gated rolls and sibling-derived Modifier values (modifier-primacy.md §6.4, §2.1).'
      ]
    );
    const contentId = content.rows[0].id;

    await client.query(
      `
        INSERT INTO item_definitions (content_id, category, equipment_type, attack_ability, damage_rolls)
        VALUES ($1, 'weapon', 'martial-melee', 'str', '')
        ON CONFLICT (content_id) DO UPDATE SET category = EXCLUDED.category, equipment_type = EXCLUDED.equipment_type,
          attack_ability = EXCLUDED.attack_ability, damage_rolls = EXCLUDED.damage_rolls
      `,
      [contentId]
    );

    const baseDie = await client.query<{ id: string }>(
      `
        INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, label, description)
        VALUES ($1, 'extra_die', '1d10', 'Flameheart Greatsword Attack', 'The weapon''s own base damage die.')
        ON CONFLICT (target, modifier_type, COALESCE(default_value_expression, '')) DO UPDATE
        SET label = EXCLUDED.label, description = EXCLUDED.description
        RETURNING id
      `,
      [weaponTarget]
    );

    const critBonus = await client.query<{ id: string }>(
      `
        INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, label, description)
        VALUES ($1, 'bonus', $2, 'Critical Hit (max dice)', 'On a critical hit, adds this weapon''s own base damage die resolved to its maximum.')
        ON CONFLICT (target, modifier_type, COALESCE(default_value_expression, '')) DO UPDATE
        SET label = EXCLUDED.label, description = EXCLUDED.description
        RETURNING id
      `,
      [weaponTarget, `sibling:max:${weaponTarget}`]
    );

    await client.query(
      `
        INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, condition_expression, priority, sort_order)
        VALUES ($1, $2, 'equipped', '', 0, 0)
        ON CONFLICT (content_id, modifier_id, activation_type, COALESCE(value_override_expression, ''), COALESCE(condition_expression, ''), priority)
        DO NOTHING
      `,
      [contentId, baseDie.rows[0].id]
    );

    await client.query(
      `
        INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, condition_expression, priority, sort_order)
        VALUES ($1, $2, 'equipped', 'on:critical_hit', 1, 1)
        ON CONFLICT (content_id, modifier_id, activation_type, COALESCE(value_override_expression, ''), COALESCE(condition_expression, ''), priority)
        DO NOTHING
      `,
      [contentId, critBonus.rows[0].id]
    );

    const character = await client.query<{ id: string }>(
      `SELECT id FROM characters WHERE name = $1 ORDER BY updated_at DESC LIMIT 1`,
      [characterName]
    );
    if (!character.rowCount) {
      throw new Error(`No character named "${characterName}" found — set TEST_CHARACTER_NAME to an existing character.`);
    }
    const characterId = character.rows[0].id;

    await client.query(
      `
        INSERT INTO character_inventory_items
          (character_id, name, category, location, quantity, equipped, is_equipment, attack_ability,
           proficient, damage_rolls, damage_bonus, to_hit_bonus, source_content_id, notes)
        SELECT $1, 'Flameheart Greatsword', 'weapon', 'equipped', 1, true, true, 'str', true, '', 0, 0, $2,
          'Test fixture: outcome-gated crit bonus + sibling-derived value source.'
        WHERE NOT EXISTS (
          SELECT 1 FROM character_inventory_items WHERE character_id = $1 AND source_content_id = $2
        )
      `,
      [characterId, contentId]
    );

    await client.query('COMMIT');
    console.log(`seeded Flameheart Greatsword (content ${contentId}) onto character "${characterName}" (${characterId})`);
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
