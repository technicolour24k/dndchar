-- 019_container_unification.sql
-- Extends content_definitions to be the unified Container type, absorbing
-- effect_definitions and action_definitions. Old tables are preserved as
-- read-only legacy until service-layer writes are migrated (see status doc §6.2).

-- ─── Step 1: Extend content_type to include 'condition' and 'action' ──────────

DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c
  FROM pg_constraint
  WHERE conrelid = 'content_definitions'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%content_type%';
  IF c IS NOT NULL THEN
    EXECUTE 'ALTER TABLE content_definitions DROP CONSTRAINT ' || quote_ident(c);
  END IF;
END $$;

ALTER TABLE content_definitions
  ADD CONSTRAINT content_definitions_content_type_check
  CHECK (content_type IN ('item', 'spell', 'feat', 'class_feature', 'condition', 'action'));

-- ─── Step 2: Add Container-level fields to content_definitions ────────────────

ALTER TABLE content_definitions
  ADD COLUMN IF NOT EXISTS activation_type text
    CHECK (activation_type IN ('passive', 'triggered', 'active_use'))
    DEFAULT 'passive',
  ADD COLUMN IF NOT EXISTS cost_json jsonb,
  ADD COLUMN IF NOT EXISTS duration_type text
    CHECK (duration_type IN ('instant', 'rounds', 'encounter', 'concentration', 'indefinite', 'permanent')),
  ADD COLUMN IF NOT EXISTS duration_rounds integer,
  ADD COLUMN IF NOT EXISTS requires_concentration boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS expiry_boundary text
    CHECK (expiry_boundary IN ('turn_start', 'turn_end', 'round_end', 'manual')),
  ADD COLUMN IF NOT EXISTS stack_behavior text NOT NULL
    CHECK (stack_behavior IN ('refresh', 'stack', 'reject')) DEFAULT 'stack',
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false;

-- ─── Step 3: Migrate effect_definitions → content_definitions (type='condition') ─

-- Keys are prefixed 'condition:' to avoid collisions with existing content_keys.
INSERT INTO content_definitions (
  content_key, content_type, name, description,
  source_kind, is_system, is_archived, created_at, updated_at,
  activation_type, duration_type, duration_rounds,
  requires_concentration, expiry_boundary, stack_behavior
)
SELECT
  'condition:' || ed.effect_key,
  'condition',
  ed.name,
  COALESCE(ed.description, ''),
  'srd',
  COALESCE(ed.is_system, true),
  COALESCE(ed.is_archived, false),
  now(),
  now(),
  'passive',
  -- Map legacy duration_type values to the new vocabulary.
  -- 'timed'/'until_start_of_next_turn' → 'rounds'
  -- 'variable'/'while_applicable'       → 'indefinite'
  -- 'concentration'                     → 'concentration'
  CASE ed.duration_type
    WHEN 'concentration'          THEN 'concentration'
    WHEN 'timed'                  THEN 'rounds'
    WHEN 'until_start_of_next_turn' THEN 'rounds'
    WHEN 'variable'               THEN 'indefinite'
    WHEN 'while_applicable'       THEN 'indefinite'
    ELSE NULL
  END,
  ed.duration_rounds,
  COALESCE(ed.requires_concentration, false),
  ed.default_expiry_boundary,
  COALESCE(ed.stack_behavior, 'refresh')
FROM effect_definitions ed
ON CONFLICT DO NOTHING;

-- ─── Step 4: Migrate effect_modifier_links → content_modifier_links ──────────

INSERT INTO content_modifier_links (
  content_id, modifier_id, activation_type,
  value_override_expression, condition_expression, priority, sort_order
)
SELECT
  cd.id,
  eml.modifier_id,
  'carried',
  eml.value_override_expression,
  eml.condition_expression,
  eml.priority,
  COALESCE(eml.priority, 0)
FROM effect_modifier_links eml
JOIN effect_definitions ed ON ed.id = eml.effect_id
JOIN content_definitions cd
  ON cd.content_key = 'condition:' || ed.effect_key AND cd.content_type = 'condition'
ON CONFLICT DO NOTHING;

-- ─── Step 5: Add container_id to active_character_effects ────────────────────

ALTER TABLE active_character_effects
  ADD COLUMN IF NOT EXISTS container_id uuid REFERENCES content_definitions(id) ON DELETE RESTRICT;

-- Back-fill container_id for every existing active effect row.
UPDATE active_character_effects ace
SET container_id = cd.id
FROM effect_definitions ed
JOIN content_definitions cd
  ON cd.content_key = 'condition:' || ed.effect_key AND cd.content_type = 'condition'
WHERE ace.effect_id = ed.id
  AND ace.container_id IS NULL;

-- ─── Step 6: Migrate content_effect_links → content_grants ───────────────────

-- Effects granted by content items are now expressed as Container grants.
INSERT INTO content_grants (source_content_id, granted_content_id, activation_type)
SELECT cel.content_id, cd.id, cel.activation_type
FROM content_effect_links cel
JOIN effect_definitions ed ON ed.id = cel.effect_id
JOIN content_definitions cd
  ON cd.content_key = 'condition:' || ed.effect_key AND cd.content_type = 'condition'
ON CONFLICT DO NOTHING;

-- ─── Step 7: Migrate action_definitions → content_definitions (type='action') ─

-- Keys are prefixed 'action:' to avoid collisions.
INSERT INTO content_definitions (
  content_key, content_type, name, description,
  source_kind, is_system, is_archived, created_at, updated_at,
  activation_type
)
SELECT
  'action:' || ad.action_key,
  'action',
  ad.name,
  COALESCE(ad.description, ''),
  'srd',
  COALESCE(ad.is_system, false),
  COALESCE(ad.is_archived, false),
  COALESCE(ad.created_at, now()),
  COALESCE(ad.updated_at, now()),
  'active_use'
FROM action_definitions ad
ON CONFLICT DO NOTHING;

-- ─── Step 8: Add container_id to action_steps ────────────────────────────────

ALTER TABLE action_steps
  ADD COLUMN IF NOT EXISTS container_id uuid REFERENCES content_definitions(id) ON DELETE CASCADE;

UPDATE action_steps ast
SET container_id = cd.id
FROM action_definitions ad
JOIN content_definitions cd
  ON cd.content_key = 'action:' || ad.action_key AND cd.content_type = 'action'
WHERE ast.action_id = ad.id
  AND ast.container_id IS NULL;

-- ─── Step 9: Add action_container_id to content_action_links ─────────────────

ALTER TABLE content_action_links
  ADD COLUMN IF NOT EXISTS action_container_id uuid
    REFERENCES content_definitions(id) ON DELETE RESTRICT;

UPDATE content_action_links cal
SET action_container_id = cd.id
FROM action_definitions ad
JOIN content_definitions cd
  ON cd.content_key = 'action:' || ad.action_key AND cd.content_type = 'action'
WHERE cal.action_id = ad.id
  AND cal.action_container_id IS NULL;

-- ─── Step 10: Indexes ─────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS content_definitions_type_archived_idx
  ON content_definitions(content_type, is_archived);

CREATE INDEX IF NOT EXISTS active_character_effects_container_idx
  ON active_character_effects(character_id, container_id)
  WHERE container_id IS NOT NULL;
