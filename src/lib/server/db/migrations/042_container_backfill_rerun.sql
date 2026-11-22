-- 042_container_backfill_rerun.sql
-- Container migration, Unit 6: re-runs 041 data steps 3, 4 and the step 6 guard to catch drift written by
-- legacy paths between deploying 041 and the container-only code (seed/import scripts, old admin writes).
-- Schema steps (041 steps 1, 2, 5) are already applied. Idempotent. MUST be applied to prod BEFORE the Unit 6 code is deployed.

-- Step 3: conditions (effect_definitions -> content_definitions type 'condition').

-- 3a. Missing containers (019's column mapping; source_kind from is_homebrew).
INSERT INTO content_definitions (
  content_key, content_type, name, description,
  source_kind, is_system, is_archived, created_at, updated_at,
  activation_type, duration_type, duration_rounds,
  requires_concentration, expiry_boundary, stack_behavior
)
SELECT
  'condition:' || ed.effect_key, 'condition', ed.name, COALESCE(ed.description, ''),
  CASE WHEN ed.is_homebrew THEN 'homebrew' ELSE 'srd' END,
  ed.is_system, ed.is_archived, now(), now(),
  'passive',
  CASE ed.duration_type
    WHEN 'concentration' THEN 'concentration'
    WHEN 'timed' THEN 'rounds'
    WHEN 'until_start_of_next_turn' THEN 'rounds'
    WHEN 'variable' THEN 'indefinite'
    WHEN 'while_applicable' THEN 'indefinite'
    ELSE NULL
  END,
  ed.duration_rounds, ed.requires_concentration, ed.default_expiry_boundary, ed.stack_behavior
FROM effect_definitions ed
ON CONFLICT DO NOTHING;

-- 3b. Legacy wins on mirrored fields, and legacy-only fields are merged into metadata_json
-- (Q2: effect_sources copied into metadata_json.legacySources). Only rows that differ are touched.
UPDATE content_definitions cd
SET name = s.name,
    description = s.description,
    is_archived = s.is_archived,
    is_system = s.is_system,
    stack_behavior = s.stack_behavior,
    duration_rounds = s.duration_rounds,
    requires_concentration = s.requires_concentration,
    expiry_boundary = s.expiry_boundary,
    duration_type = s.duration_type,
    source_ref = s.source_ref,
    metadata_json = cd.metadata_json || s.meta,
    updated_at = now()
FROM (
  SELECT
    'condition:' || ed.effect_key AS content_key,
    ed.name, COALESCE(ed.description, '') AS description, ed.is_archived, ed.is_system,
    ed.stack_behavior, ed.duration_rounds, ed.requires_concentration,
    ed.default_expiry_boundary AS expiry_boundary,
    CASE ed.duration_type
      WHEN 'concentration' THEN 'concentration'
      WHEN 'timed' THEN 'rounds'
      WHEN 'until_start_of_next_turn' THEN 'rounds'
      WHEN 'variable' THEN 'indefinite'
      WHEN 'while_applicable' THEN 'indefinite'
      ELSE NULL
    END AS duration_type,
    ed.source_ref,
    jsonb_build_object(
      'sourceType', ed.source_type,
      'isCondition', ed.is_condition,
      'isSelectable', ed.is_selectable,
      'isHomebrew', ed.is_homebrew,
      'sortOrder', ed.sort_order,
      'legacyDurationType', ed.duration_type,
      'legacyEffectId', ed.id,
      'legacySources', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'sourceType', es.source_type, 'sourceRef', es.source_ref, 'sourceName', es.source_name,
          'isHomebrew', es.is_homebrew, 'ownerUserId', es.owner_user_id, 'metadata', es.metadata_json
        ) ORDER BY es.source_ref)
        FROM effect_sources es WHERE es.effect_id = ed.id
      ), '[]'::jsonb)
    ) || CASE WHEN ed.metadata_json ? 'managedByContentAdmin'
         THEN jsonb_build_object('managedByContentAdmin', ed.metadata_json -> 'managedByContentAdmin')
         ELSE '{}'::jsonb END AS meta
  FROM effect_definitions ed
) s
WHERE cd.content_type = 'condition' AND cd.content_key = s.content_key
  AND (
    cd.name IS DISTINCT FROM s.name
    OR cd.description IS DISTINCT FROM s.description
    OR cd.is_archived IS DISTINCT FROM s.is_archived
    OR cd.is_system IS DISTINCT FROM s.is_system
    OR cd.stack_behavior IS DISTINCT FROM s.stack_behavior
    OR cd.duration_rounds IS DISTINCT FROM s.duration_rounds
    OR cd.requires_concentration IS DISTINCT FROM s.requires_concentration
    OR cd.expiry_boundary IS DISTINCT FROM s.expiry_boundary
    OR cd.duration_type IS DISTINCT FROM s.duration_type
    OR cd.source_ref IS DISTINCT FROM s.source_ref
    OR cd.metadata_json IS DISTINCT FROM (cd.metadata_json || s.meta)
  );

-- 3c. Missing modifier links (insert-only; the unique index dedupes).
INSERT INTO content_modifier_links (
  content_id, modifier_id, activation_type,
  value_override_expression, condition_expression, priority, sort_order
)
SELECT cd.id, eml.modifier_id, 'carried',
       eml.value_override_expression, eml.condition_expression, eml.priority, COALESCE(eml.priority, 0)
FROM effect_modifier_links eml
JOIN effect_definitions ed ON ed.id = eml.effect_id
JOIN content_definitions cd ON cd.content_type = 'condition' AND cd.content_key = 'condition:' || ed.effect_key
ON CONFLICT DO NOTHING;

-- 3d. Active effects.
UPDATE active_character_effects ace
SET container_id = cd.id
FROM effect_definitions ed
JOIN content_definitions cd ON cd.content_type = 'condition' AND cd.content_key = 'condition:' || ed.effect_key
WHERE ace.effect_id = ed.id AND ace.container_id IS NULL;

-- 3e. Content -> condition grants (all activation types, as 019 did).
INSERT INTO content_grants (source_content_id, granted_content_id, activation_type)
SELECT cel.content_id, cd.id, cel.activation_type
FROM content_effect_links cel
JOIN effect_definitions ed ON ed.id = cel.effect_id
JOIN content_definitions cd ON cd.content_type = 'condition' AND cd.content_key = 'condition:' || ed.effect_key
ON CONFLICT DO NOTHING;

-- 3f. Steps that apply/remove a condition.
UPDATE action_steps s
SET effect_container_id = cd.id
FROM effect_definitions ed
JOIN content_definitions cd ON cd.content_type = 'condition' AND cd.content_key = 'condition:' || ed.effect_key
WHERE s.effect_id = ed.id AND s.effect_container_id IS NULL;

-- Step 4: actions (action_definitions -> content_definitions type 'action').
-- First match wins: an existing link container, 'action:'||key, the bare key (catalogue.ts), else a new one.
DROP TABLE IF EXISTS action_container_map;
CREATE TEMP TABLE action_container_map ON COMMIT DROP AS
SELECT ad.id AS action_id,
  COALESCE(
    (SELECT min(cal.action_container_id::text)::uuid FROM content_action_links cal
      WHERE cal.action_id = ad.id AND cal.action_container_id IS NOT NULL),
    (SELECT cd.id FROM content_definitions cd WHERE cd.content_type = 'action' AND cd.owner_user_id IS NULL
      AND cd.content_key IN ('action:' || ad.action_key, ad.action_key)
      ORDER BY (cd.content_key = 'action:' || ad.action_key) DESC LIMIT 1)
  ) AS container_id
FROM action_definitions ad;

INSERT INTO content_definitions (
  content_key, content_type, name, description,
  source_kind, is_system, is_archived, created_at, updated_at, activation_type
)
SELECT 'action:' || ad.action_key, 'action', ad.name, COALESCE(ad.description, ''),
       'srd', ad.is_system, ad.is_archived, ad.created_at, ad.updated_at, 'active_use'
FROM action_definitions ad
JOIN action_container_map m ON m.action_id = ad.id
WHERE m.container_id IS NULL
ON CONFLICT DO NOTHING;

UPDATE action_container_map m
SET container_id = cd.id
FROM action_definitions ad
JOIN content_definitions cd ON cd.content_type = 'action' AND cd.content_key = 'action:' || ad.action_key
WHERE m.container_id IS NULL AND ad.id = m.action_id;

-- Sync name/description/archived legacy -> container.
UPDATE content_definitions cd
SET name = ad.name, description = COALESCE(ad.description, ''), is_archived = ad.is_archived, updated_at = now()
FROM action_definitions ad
JOIN action_container_map m ON m.action_id = ad.id
WHERE cd.id = m.container_id
  AND (cd.name IS DISTINCT FROM ad.name
    OR cd.description IS DISTINCT FROM COALESCE(ad.description, '')
    OR cd.is_archived IS DISTINCT FROM ad.is_archived);

-- Links and steps follow the map (also repairs the catalogue.ts NULL-overwrite bug).
UPDATE content_action_links cal
SET action_container_id = m.container_id
FROM action_container_map m
WHERE cal.action_id = m.action_id AND m.container_id IS NOT NULL
  AND cal.action_container_id IS DISTINCT FROM m.container_id;

UPDATE action_steps s
SET container_id = m.container_id
FROM action_container_map m
WHERE s.action_id = m.action_id AND m.container_id IS NOT NULL
  AND s.container_id IS DISTINCT FROM m.container_id;

-- Step 6: guard. A failure rolls the whole file back (the runner wraps it in a transaction).
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM effect_definitions ed
    WHERE NOT EXISTS (SELECT 1 FROM content_definitions cd
      WHERE cd.content_type = 'condition' AND cd.content_key = 'condition:' || ed.effect_key);
  IF n > 0 THEN RAISE EXCEPTION '042 guard: % effect_definitions without a condition container', n; END IF;

  SELECT count(*) INTO n FROM action_container_map WHERE container_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '042 guard: % action_definitions unmapped', n; END IF;

  SELECT count(*) INTO n FROM active_character_effects WHERE container_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '042 guard: % active effects with NULL container_id', n; END IF;

  SELECT count(*) INTO n FROM action_steps WHERE container_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '042 guard: % action_steps with NULL container_id', n; END IF;

  SELECT count(*) INTO n FROM action_steps WHERE effect_id IS NOT NULL AND effect_container_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '042 guard: % action_steps with effect_id but no effect_container_id', n; END IF;

  SELECT count(*) INTO n FROM content_action_links WHERE action_container_id IS NULL;
  IF n > 0 THEN RAISE EXCEPTION '042 guard: % content_action_links with NULL action_container_id', n; END IF;
END $$;
