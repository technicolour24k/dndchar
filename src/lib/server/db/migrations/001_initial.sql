CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS characters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  ancestry text NOT NULL DEFAULT '',
  background text NOT NULL DEFAULT '',
  system_key text NOT NULL DEFAULT 'dnd5e2014',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS characters_owner_user_id_idx ON characters(owner_user_id);

CREATE TABLE IF NOT EXISTS character_classes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  class_name text NOT NULL,
  level integer NOT NULL DEFAULT 1,
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS character_abilities (
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  ability_key text NOT NULL CHECK (ability_key IN ('str', 'dex', 'con', 'int', 'wis', 'cha')),
  score integer NOT NULL DEFAULT 10,
  PRIMARY KEY (character_id, ability_key)
);

CREATE TABLE IF NOT EXISTS character_resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  resource_key text NOT NULL,
  label text NOT NULL,
  current_value integer NOT NULL DEFAULT 0,
  max_value integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE(character_id, resource_key)
);

CREATE TABLE IF NOT EXISTS character_inventory_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'gear',
  quantity integer NOT NULL DEFAULT 1,
  equipped boolean NOT NULL DEFAULT false,
  ac_bonus integer NOT NULL DEFAULT 0,
  str_bonus integer NOT NULL DEFAULT 0,
  dex_bonus integer NOT NULL DEFAULT 0,
  con_bonus integer NOT NULL DEFAULT 0,
  int_bonus integer NOT NULL DEFAULT 0,
  wis_bonus integer NOT NULL DEFAULT 0,
  cha_bonus integer NOT NULL DEFAULT 0,
  notes text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS character_attacks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  name text NOT NULL,
  attack_ability text NOT NULL DEFAULT 'str' CHECK (attack_ability IN ('str', 'dex', 'con', 'int', 'wis', 'cha')),
  proficient boolean NOT NULL DEFAULT true,
  damage_dice text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS character_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  note_key text NOT NULL,
  title text NOT NULL,
  content text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  UNIQUE(character_id, note_key)
);

CREATE TABLE IF NOT EXISTS character_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  created_by_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  change_summary text NOT NULL DEFAULT '',
  snapshot_json jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS character_versions_character_created_idx
  ON character_versions(character_id, created_at DESC);
