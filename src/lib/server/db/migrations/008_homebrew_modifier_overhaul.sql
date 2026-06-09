ALTER TABLE effect_definitions
  ADD COLUMN IF NOT EXISTS is_homebrew boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE effect_sources
  ADD COLUMN IF NOT EXISTS is_homebrew boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE modifier_definitions
  ADD COLUMN IF NOT EXISTS label text,
  ADD COLUMN IF NOT EXISTS description text,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE effect_modifier_links
  ADD COLUMN IF NOT EXISTS value_override_expression text,
  ADD COLUMN IF NOT EXISTS metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'modifier_definitions'
      AND column_name = 'value_expression'
  ) AND NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_name = 'modifier_definitions'
      AND column_name = 'default_value_expression'
  ) THEN
    ALTER TABLE modifier_definitions
      RENAME COLUMN value_expression TO default_value_expression;
  END IF;
END $$;

ALTER TABLE modifier_definitions
  ADD COLUMN IF NOT EXISTS default_value_expression text;

DROP INDEX IF EXISTS modifier_definitions_unique_shape_idx;

CREATE UNIQUE INDEX IF NOT EXISTS modifier_definitions_unique_shape_idx
  ON modifier_definitions(target, modifier_type, COALESCE(default_value_expression, ''));

DROP INDEX IF EXISTS effect_modifier_links_unique_idx;

CREATE UNIQUE INDEX IF NOT EXISTS effect_modifier_links_unique_idx
  ON effect_modifier_links(
    effect_id,
    modifier_id,
    COALESCE(value_override_expression, ''),
    COALESCE(condition_expression, ''),
    priority
  );

CREATE INDEX IF NOT EXISTS effect_definitions_owner_idx
  ON effect_definitions(owner_user_id, is_homebrew, name);

CREATE INDEX IF NOT EXISTS effect_sources_owner_idx
  ON effect_sources(owner_user_id, is_homebrew, source_type, source_name);

CREATE INDEX IF NOT EXISTS effect_modifier_links_modifier_id_idx
  ON effect_modifier_links(modifier_id);
