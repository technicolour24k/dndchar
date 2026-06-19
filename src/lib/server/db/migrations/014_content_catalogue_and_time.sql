ALTER TABLE users
  ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'user'
  CHECK (role IN ('user', 'admin'));

UPDATE users
SET role = 'admin'
WHERE id = (SELECT id FROM users ORDER BY created_at ASC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'admin');

CREATE TABLE IF NOT EXISTS modifier_targets (
  target_key text PRIMARY KEY,
  label text NOT NULL,
  category text NOT NULL DEFAULT 'general',
  value_kind text NOT NULL DEFAULT 'number'
    CHECK (value_kind IN ('none', 'number', 'dice', 'formula', 'text')),
  runtime_supported boolean NOT NULL DEFAULT false,
  description text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO modifier_targets (target_key, label, category, value_kind, runtime_supported) VALUES
  ('ac', 'Armor Class', 'combat', 'number', true),
  ('initiative', 'Initiative', 'combat', 'number', true),
  ('ability_check.all', 'All Ability Checks', 'checks', 'dice', true),
  ('ability_check.stealth', 'Stealth Checks', 'checks', 'dice', true),
  ('saving_throw.all', 'All Saving Throws', 'saves', 'dice', true),
  ('saving_throw.wis', 'Wisdom Saving Throws', 'saves', 'dice', true),
  ('attack_roll.all', 'All Attack Rolls', 'combat', 'dice', true),
  ('damage_roll.all', 'All Damage Rolls', 'damage', 'number', true),
  ('damage_roll.melee_weapon', 'Melee Weapon Damage', 'damage', 'number', true),
  ('damage_roll.melee_weapon.dex', 'DEX Melee Weapon Damage', 'damage', 'number', true),
  ('spell_save_dc', 'Spell Save DC', 'spellcasting', 'number', true),
  ('spell_attack_roll', 'Spell Attack Rolls', 'spellcasting', 'number', true),
  ('spell_slots.highest.max', 'Highest-level Spell Slots', 'spellcasting', 'number', true),
  ('speed.all', 'Speed', 'movement', 'number', true)
ON CONFLICT (target_key) DO UPDATE SET
  label = EXCLUDED.label,
  category = EXCLUDED.category,
  value_kind = EXCLUDED.value_kind,
  runtime_supported = EXCLUDED.runtime_supported;

INSERT INTO modifier_targets (target_key, label, category, value_kind, runtime_supported)
SELECT DISTINCT target, COALESCE(NULLIF(label, ''), target), split_part(target, '.', 1),
  CASE WHEN modifier_type IN ('advantage', 'disadvantage', 'block', 'grant', 'resistance', 'immunity', 'vulnerability') THEN 'none' ELSE 'formula' END,
  target ~ '^(ac|initiative|ability_check|saving_throw|attack_roll|damage_roll|speed|spell_save_dc|spell_attack_roll|spell_slots)'
FROM modifier_definitions
ON CONFLICT (target_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS content_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_key text NOT NULL,
  content_type text NOT NULL CHECK (content_type IN ('item', 'spell', 'feat', 'class_feature')),
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  source_kind text NOT NULL DEFAULT 'homebrew' CHECK (source_kind IN ('srd', 'homebrew')),
  source_ref text,
  owner_user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  publication_status text NOT NULL DEFAULT 'private'
    CHECK (publication_status IN ('private', 'pending', 'published')),
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS content_definitions_global_key_idx
  ON content_definitions(content_key) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS content_definitions_owner_key_idx
  ON content_definitions(owner_user_id, content_key) WHERE owner_user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS content_definitions_search_idx
  ON content_definitions(content_type, publication_status, lower(name));

CREATE TABLE IF NOT EXISTS spell_definitions (
  content_id uuid PRIMARY KEY REFERENCES content_definitions(id) ON DELETE CASCADE,
  spell_level integer NOT NULL DEFAULT 0 CHECK (spell_level BETWEEN 0 AND 9),
  school text NOT NULL DEFAULT '',
  casting_time text NOT NULL DEFAULT '',
  spell_range text NOT NULL DEFAULT '',
  components text NOT NULL DEFAULT '',
  duration text NOT NULL DEFAULT '',
  ritual boolean NOT NULL DEFAULT false,
  concentration boolean NOT NULL DEFAULT false,
  classes text[] NOT NULL DEFAULT '{}',
  higher_level text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS item_definitions (
  content_id uuid PRIMARY KEY REFERENCES content_definitions(id) ON DELETE CASCADE,
  category text NOT NULL DEFAULT 'gear',
  equipment_type text NOT NULL DEFAULT 'item',
  requires_attunement boolean NOT NULL DEFAULT false,
  ac_bonus integer NOT NULL DEFAULT 0,
  to_hit_bonus integer NOT NULL DEFAULT 0,
  damage_bonus integer NOT NULL DEFAULT 0,
  attack_ability text NOT NULL DEFAULT 'str',
  damage_rolls text NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS content_effect_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  effect_id uuid NOT NULL REFERENCES effect_definitions(id) ON DELETE CASCADE,
  activation_type text NOT NULL DEFAULT 'manual'
    CHECK (activation_type IN ('carried', 'equipped', 'attuned', 'on_use', 'manual')),
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE(content_id, effect_id, activation_type)
);

CREATE TABLE IF NOT EXISTS content_grants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  granted_content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  activation_type text NOT NULL DEFAULT 'equipped'
    CHECK (activation_type IN ('carried', 'equipped', 'attuned', 'on_use', 'manual')),
  UNIQUE(source_content_id, granted_content_id, activation_type),
  CHECK (source_content_id <> granted_content_id)
);

CREATE TABLE IF NOT EXISTS content_resource_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  label text NOT NULL,
  max_value_expression text NOT NULL DEFAULT '1',
  recharge_period text NOT NULL DEFAULT 'manual'
    CHECK (recharge_period IN ('short_rest', 'long_rest', 'dawn', 'round', 'encounter', 'manual')),
  UNIQUE(content_id, resource_key)
);

CREATE TABLE IF NOT EXISTS character_content_instances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE RESTRICT,
  source_class_id uuid REFERENCES character_classes(id) ON DELETE SET NULL,
  is_known boolean NOT NULL DEFAULT true,
  is_prepared boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  custom_name text,
  notes text NOT NULL DEFAULT '',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id, content_id)
);

CREATE INDEX IF NOT EXISTS character_content_character_idx
  ON character_content_instances(character_id);

CREATE TABLE IF NOT EXISTS character_content_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_content_id uuid NOT NULL REFERENCES character_content_instances(id) ON DELETE CASCADE,
  resource_definition_id uuid NOT NULL REFERENCES content_resource_definitions(id) ON DELETE CASCADE,
  current_value integer NOT NULL DEFAULT 0,
  max_value integer NOT NULL DEFAULT 0,
  UNIQUE(character_content_id, resource_definition_id)
);

CREATE TABLE IF NOT EXISTS character_spell_slots (
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  slot_type text NOT NULL CHECK (slot_type IN ('standard', 'pact')),
  slot_level integer NOT NULL CHECK (slot_level BETWEEN 1 AND 9),
  current_slots integer NOT NULL DEFAULT 0 CHECK (current_slots >= 0),
  max_slots integer NOT NULL DEFAULT 0 CHECK (max_slots >= 0),
  PRIMARY KEY (character_id, slot_type, slot_level)
);

CREATE TABLE IF NOT EXISTS character_combat_clocks (
  character_id uuid PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  round_number integer NOT NULL DEFAULT 1 CHECK (round_number >= 1),
  turn_number integer NOT NULL DEFAULT 1 CHECK (turn_number >= 1),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS encounters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  round_number integer NOT NULL DEFAULT 1 CHECK (round_number >= 1),
  current_turn_index integer NOT NULL DEFAULT 0 CHECK (current_turn_index >= 0),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS encounter_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  character_id uuid REFERENCES characters(id) ON DELETE CASCADE,
  name text NOT NULL,
  initiative integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE(encounter_id, character_id)
);

ALTER TABLE character_inventory_items
  ADD COLUMN IF NOT EXISTS source_content_id uuid REFERENCES content_definitions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS attuned boolean NOT NULL DEFAULT false;

ALTER TABLE character_classes
  ADD COLUMN IF NOT EXISTS subclass_name text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS spellcasting_ability text;

ALTER TABLE active_character_effects
  ADD COLUMN IF NOT EXISTS source_content_instance_id uuid REFERENCES character_content_instances(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS expiry_boundary text NOT NULL DEFAULT 'round_end'
    CHECK (expiry_boundary IN ('turn_start', 'turn_end', 'round_end', 'manual'));

