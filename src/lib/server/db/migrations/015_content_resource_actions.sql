CREATE TABLE IF NOT EXISTS content_resource_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  action_operation text NOT NULL CHECK (action_operation IN ('add', 'subtract', 'set')),
  target_type text NOT NULL CHECK (target_type IN ('hp', 'temp_hp', 'spell_slot', 'coin')),
  target_key text NOT NULL DEFAULT '',
  value_expression text NOT NULL DEFAULT '0',
  activation_type text NOT NULL DEFAULT 'on_use'
    CHECK (activation_type IN ('on_use', 'manual')),
  label text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS content_resource_actions_content_idx
  ON content_resource_actions(content_id, activation_type, sort_order);
