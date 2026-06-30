ALTER TABLE modifier_targets
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE modifier_targets SET is_system = true WHERE runtime_supported = true;

ALTER TABLE modifier_definitions
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE modifier_definitions modifier
SET is_system = true
WHERE EXISTS (
  SELECT 1 FROM effect_modifier_links link
  JOIN effect_definitions effect ON effect.id = link.effect_id
  WHERE link.modifier_id = modifier.id AND COALESCE(effect.is_homebrew, false) = false
);

ALTER TABLE effect_definitions
  ADD COLUMN IF NOT EXISTS stack_behavior text NOT NULL DEFAULT 'refresh'
    CHECK (stack_behavior IN ('refresh', 'stack', 'reject')),
  ADD COLUMN IF NOT EXISTS default_expiry_boundary text NOT NULL DEFAULT 'round_end'
    CHECK (default_expiry_boundary IN ('turn_start', 'turn_end', 'round_end', 'manual')),
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_system boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

UPDATE effect_definitions SET is_system = NOT COALESCE(is_homebrew, false);

ALTER TABLE content_definitions
  ADD COLUMN IF NOT EXISTS is_archived boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS content_modifier_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  modifier_id uuid NOT NULL REFERENCES modifier_definitions(id) ON DELETE RESTRICT,
  activation_type text NOT NULL DEFAULT 'manual'
    CHECK (activation_type IN ('carried', 'equipped', 'attuned', 'known', 'prepared', 'manual')),
  value_override_expression text,
  condition_expression text,
  priority integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS content_modifier_links_unique_idx
  ON content_modifier_links(
    content_id, modifier_id, activation_type,
    COALESCE(value_override_expression, ''), COALESCE(condition_expression, ''), priority
  );
CREATE INDEX IF NOT EXISTS content_modifier_links_content_idx
  ON content_modifier_links(content_id, activation_type, sort_order);

INSERT INTO content_modifier_links
  (content_id, modifier_id, activation_type, value_override_expression, condition_expression, priority, sort_order)
SELECT content_link.content_id, modifier_link.modifier_id, content_link.activation_type,
  modifier_link.value_override_expression, modifier_link.condition_expression,
  modifier_link.priority, modifier_link.priority
FROM content_effect_links content_link
JOIN effect_definitions effect ON effect.id = content_link.effect_id
JOIN effect_modifier_links modifier_link ON modifier_link.effect_id = effect.id
WHERE COALESCE((effect.metadata_json->>'managedByContentAdmin')::boolean, false) = true
  AND content_link.activation_type IN ('carried', 'equipped', 'attuned', 'manual')
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS action_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_key text NOT NULL UNIQUE,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  is_system boolean NOT NULL DEFAULT false,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS action_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  action_id uuid NOT NULL REFERENCES action_definitions(id) ON DELETE CASCADE,
  step_type text NOT NULL CHECK (step_type IN (
    'resource_change', 'damage', 'healing', 'apply_effect', 'remove_effect',
    'spend_resource', 'spend_item', 'roll_output'
  )),
  operation text NOT NULL DEFAULT 'add' CHECK (operation IN ('add', 'subtract', 'set', 'roll', 'apply', 'remove', 'spend')),
  target_type text NOT NULL DEFAULT '',
  target_key text NOT NULL DEFAULT '',
  value_expression text NOT NULL DEFAULT '',
  effect_id uuid REFERENCES effect_definitions(id) ON DELETE RESTRICT,
  target_mode text NOT NULL DEFAULT 'self' CHECK (target_mode IN ('self', 'external_roll')),
  label text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS action_steps_action_idx ON action_steps(action_id, sort_order, created_at);

CREATE TABLE IF NOT EXISTS content_action_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  action_id uuid NOT NULL REFERENCES action_definitions(id) ON DELETE RESTRICT,
  trigger_type text NOT NULL DEFAULT 'manual' CHECK (trigger_type IN ('on_use', 'manual', 'on_cast')),
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE(content_id, action_id, trigger_type)
);

INSERT INTO action_definitions (action_key, name, description, owner_user_id)
SELECT 'migrated:content:' || content.id::text || ':' || resource.activation_type,
  CASE WHEN resource.activation_type = 'on_use' THEN 'Use ' ELSE 'Activate ' END || content.name,
  'Migrated catalogue action for ' || content.name, content.owner_user_id
FROM content_resource_actions resource
JOIN content_definitions content ON content.id = resource.content_id
GROUP BY content.id, content.name, content.owner_user_id, resource.activation_type
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO content_action_links (content_id, action_id, trigger_type)
SELECT content.id, action.id,
  CASE WHEN resource.activation_type = 'on_use' THEN 'on_use' ELSE 'manual' END
FROM content_resource_actions resource
JOIN content_definitions content ON content.id = resource.content_id
JOIN action_definitions action
  ON action.action_key = 'migrated:content:' || content.id::text || ':' || resource.activation_type
GROUP BY content.id, action.id, resource.activation_type
ON CONFLICT DO NOTHING;

INSERT INTO action_steps
  (action_id, step_type, operation, target_type, target_key, value_expression, label, sort_order)
SELECT action.id, 'resource_change', resource.action_operation, resource.target_type,
  resource.target_key, resource.value_expression, resource.label, resource.sort_order
FROM content_resource_actions resource
JOIN action_definitions action
  ON action.action_key = 'migrated:content:' || resource.content_id::text || ':' || resource.activation_type
WHERE NOT EXISTS (
  SELECT 1 FROM action_steps step
  WHERE step.action_id = action.id AND step.step_type = 'resource_change'
    AND step.operation = resource.action_operation AND step.target_type = resource.target_type
    AND step.target_key = resource.target_key AND step.value_expression = resource.value_expression
    AND step.sort_order = resource.sort_order
);

INSERT INTO action_definitions (action_key, name, description, owner_user_id)
SELECT 'migrated:content:' || content.id::text || ':on_use', 'Use ' || content.name,
  'Migrated on-use action for ' || content.name, content.owner_user_id
FROM content_effect_links link
JOIN content_definitions content ON content.id = link.content_id
WHERE link.activation_type = 'on_use'
GROUP BY content.id, content.name, content.owner_user_id
ON CONFLICT (action_key) DO NOTHING;

INSERT INTO content_action_links (content_id, action_id, trigger_type)
SELECT content.id, action.id, 'on_use'
FROM content_effect_links link
JOIN content_definitions content ON content.id = link.content_id
JOIN action_definitions action ON action.action_key = 'migrated:content:' || content.id::text || ':on_use'
WHERE link.activation_type = 'on_use'
GROUP BY content.id, action.id
ON CONFLICT DO NOTHING;

INSERT INTO action_steps (action_id, step_type, operation, effect_id, label, sort_order)
SELECT action.id, 'apply_effect', 'apply', link.effect_id, effect.name,
  1000 + row_number() OVER (PARTITION BY content.id ORDER BY link.sort_order, link.id)
FROM content_effect_links link
JOIN content_definitions content ON content.id = link.content_id
JOIN effect_definitions effect ON effect.id = link.effect_id
JOIN action_definitions action ON action.action_key = 'migrated:content:' || content.id::text || ':on_use'
WHERE link.activation_type = 'on_use'
  AND NOT EXISTS (
    SELECT 1 FROM action_steps step
    WHERE step.action_id = action.id AND step.step_type = 'apply_effect' AND step.effect_id = link.effect_id
  );

CREATE TABLE IF NOT EXISTS content_spell_access (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  spell_content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE RESTRICT,
  access_type text NOT NULL CHECK (access_type IN ('charges', 'limited_free', 'at_will', 'character_slots')),
  availability_type text NOT NULL DEFAULT 'equipped'
    CHECK (availability_type IN ('carried', 'equipped', 'attuned', 'known', 'prepared', 'manual')),
  resource_definition_id uuid REFERENCES content_resource_definitions(id) ON DELETE SET NULL,
  resource_cost_expression text NOT NULL DEFAULT '1',
  use_limit_expression text,
  recharge_period text CHECK (recharge_period IN ('short_rest', 'long_rest', 'dawn', 'round', 'encounter', 'manual')),
  cast_level_mode text NOT NULL DEFAULT 'spell_level'
    CHECK (cast_level_mode IN ('spell_level', 'fixed', 'charges_spent', 'selected_slot')),
  fixed_cast_level integer CHECK (fixed_cast_level BETWEEN 0 AND 9),
  save_dc_mode text NOT NULL DEFAULT 'character' CHECK (save_dc_mode IN ('character', 'fixed')),
  fixed_save_dc integer,
  spell_attack_mode text NOT NULL DEFAULT 'character' CHECK (spell_attack_mode IN ('character', 'fixed')),
  fixed_spell_attack_bonus integer,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(owner_content_id, spell_content_id, access_type)
);

CREATE TABLE IF NOT EXISTS character_inventory_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inventory_item_id uuid NOT NULL REFERENCES character_inventory_items(id) ON DELETE CASCADE,
  resource_definition_id uuid NOT NULL REFERENCES content_resource_definitions(id) ON DELETE CASCADE,
  current_value integer NOT NULL DEFAULT 0,
  max_value integer NOT NULL DEFAULT 0,
  UNIQUE(inventory_item_id, resource_definition_id)
);

ALTER TABLE active_character_effects
  DROP CONSTRAINT IF EXISTS active_character_effects_character_id_effect_id_key;

ALTER TABLE active_character_effects
  ADD COLUMN IF NOT EXISTS source_key text,
  ADD COLUMN IF NOT EXISTS application_key uuid NOT NULL DEFAULT gen_random_uuid();

CREATE INDEX IF NOT EXISTS active_character_effects_lookup_idx
  ON active_character_effects(character_id, effect_id, started_at);
