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

async function main() {
  await pool.query(`
    ALTER TABLE effect_definitions
      ADD COLUMN IF NOT EXISTS is_selectable boolean NOT NULL DEFAULT true
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS effect_sources (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      effect_id uuid NOT NULL REFERENCES effect_definitions(id) ON DELETE CASCADE,
      source_type text NOT NULL,
      source_ref text NOT NULL,
      source_name text,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(effect_id, source_ref)
    )
  `);

  await pool.query(`
    INSERT INTO effect_definitions (
      effect_key,
      name,
      source_type,
      source_ref,
      description,
      duration_type,
      requires_concentration,
      is_condition,
      is_selectable,
      sort_order
    )
    VALUES (
      'feature_ability_score_improvement',
      'Ability Score Improvement',
      'class_feature',
      'feature.ability-score-improvement',
      'When eligible, increase one ability score by 2 or two ability scores by 1, subject to the normal maximum.',
      'permanent',
      false,
      false,
      false,
      900
    )
    ON CONFLICT (effect_key) DO UPDATE
    SET name = EXCLUDED.name,
        description = EXCLUDED.description,
        is_selectable = false
  `);

  await pool.query(`
    INSERT INTO effect_sources (effect_id, source_type, source_ref, source_name)
    SELECT canonical.id, duplicates.source_type, duplicates.source_ref, duplicates.name
    FROM effect_definitions duplicates
    CROSS JOIN effect_definitions canonical
    WHERE canonical.effect_key = 'feature_ability_score_improvement'
      AND duplicates.source_ref LIKE 'features.%ability-score-improvement%'
    ON CONFLICT (effect_id, source_ref) DO UPDATE
    SET source_name = EXCLUDED.source_name
  `);

  await pool.query(`
    UPDATE effect_definitions
    SET is_selectable = false
    WHERE source_ref LIKE 'features.%ability-score-improvement%'
      AND effect_key <> 'feature_ability_score_improvement'
      AND NOT EXISTS (
        SELECT 1
        FROM effect_modifiers
        WHERE effect_modifiers.effect_id = effect_definitions.id
      )
  `);

  const result = await pool.query(`
    WITH classified AS (
      SELECT
        effect_definitions.id,
        EXISTS (
          SELECT 1
          FROM effect_modifiers
          WHERE effect_modifiers.effect_id = effect_definitions.id
        ) AS has_modifiers,
        source_type,
        source_ref,
        lower(coalesce(description, '')) AS description,
        duration_type,
        requires_concentration,
        is_condition
      FROM effect_definitions
    )
    UPDATE effect_definitions
    SET is_selectable =
      CASE
        WHEN classified.has_modifiers THEN true
        WHEN classified.is_condition THEN true
        WHEN classified.source_ref IN ('feature.ability-score-improvement', 'spell.acid-arrow') THEN false
        WHEN classified.source_type = 'spell' AND classified.duration_type = 'instantaneous' THEN false
        WHEN classified.source_type = 'spell' AND classified.requires_concentration THEN true
        WHEN classified.source_type IN ('spell', 'class_feature', 'trait') AND (
          classified.description LIKE '%advantage%'
          OR classified.description LIKE '%disadvantage%'
          OR classified.description LIKE '%resistance%'
          OR classified.description LIKE '%immune%'
          OR classified.description LIKE '%speed%'
          OR classified.description LIKE '%armor class%'
          OR classified.description LIKE '%saving throw%'
          OR classified.description LIKE '%attack roll%'
          OR classified.description LIKE '%damage roll%'
          OR classified.description LIKE '%temporary hit points%'
          OR classified.description LIKE '%hit point maximum%'
          OR classified.description LIKE '%condition%'
          OR classified.description LIKE '%concentration%'
          OR classified.description LIKE '%spellcasting%'
          OR classified.description LIKE '%bonus to%'
          OR classified.description LIKE '%penalty%'
        ) THEN true
        ELSE false
      END
    FROM classified
    WHERE classified.id = effect_definitions.id
  `);

  console.log(`trimmed ${result.rowCount ?? 0} effect definitions`);
}

main()
  .finally(() => pool.end())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
