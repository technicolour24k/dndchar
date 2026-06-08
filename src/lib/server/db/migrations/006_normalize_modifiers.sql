CREATE TABLE IF NOT EXISTS modifier_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  target text NOT NULL,
  modifier_type text NOT NULL,
  value_expression text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS modifier_definitions_unique_shape_idx
  ON modifier_definitions(target, modifier_type, COALESCE(value_expression, ''));

CREATE TABLE IF NOT EXISTS effect_modifier_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effect_id uuid NOT NULL REFERENCES effect_definitions(id) ON DELETE CASCADE,
  modifier_id uuid NOT NULL REFERENCES modifier_definitions(id) ON DELETE CASCADE,
  condition_expression text,
  priority integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS effect_modifier_links_effect_id_idx
  ON effect_modifier_links(effect_id);

CREATE UNIQUE INDEX IF NOT EXISTS effect_modifier_links_unique_idx
  ON effect_modifier_links(effect_id, modifier_id, COALESCE(condition_expression, ''), priority);

INSERT INTO modifier_definitions (target, modifier_type, value_expression)
SELECT DISTINCT target, modifier_type, value_expression
FROM effect_modifiers
ON CONFLICT (target, modifier_type, COALESCE(value_expression, '')) DO NOTHING;

INSERT INTO effect_modifier_links (effect_id, modifier_id, condition_expression, priority)
SELECT
  effect_modifiers.effect_id,
  modifier_definitions.id,
  effect_modifiers.condition_expression,
  effect_modifiers.priority
FROM effect_modifiers
JOIN modifier_definitions
  ON modifier_definitions.target = effect_modifiers.target
  AND modifier_definitions.modifier_type = effect_modifiers.modifier_type
  AND COALESCE(modifier_definitions.value_expression, '') = COALESCE(effect_modifiers.value_expression, '')
ON CONFLICT (effect_id, modifier_id, COALESCE(condition_expression, ''), priority) DO NOTHING;
