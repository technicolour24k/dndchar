CREATE TABLE IF NOT EXISTS character_proficiencies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  proficiency_type text NOT NULL CHECK (proficiency_type IN ('saving_throw', 'skill', 'weapon')),
  proficiency_key text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id, proficiency_type, proficiency_key)
);

CREATE INDEX IF NOT EXISTS character_proficiencies_character_type_idx
  ON character_proficiencies(character_id, proficiency_type);
