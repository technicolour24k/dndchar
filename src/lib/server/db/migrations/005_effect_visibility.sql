ALTER TABLE effect_definitions
  ADD COLUMN IF NOT EXISTS is_selectable boolean NOT NULL DEFAULT true;

UPDATE effect_definitions
SET is_selectable = false
WHERE source_ref IN (
    'feature.ability-score-improvement',
    'spell.acid-arrow'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM effect_modifiers
    WHERE effect_modifiers.effect_id = effect_definitions.id
  );

CREATE INDEX IF NOT EXISTS effect_definitions_selectable_idx
  ON effect_definitions(is_selectable, source_type, name);
