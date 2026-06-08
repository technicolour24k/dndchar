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
