CREATE TABLE IF NOT EXISTS combat_log_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  encounter_id uuid NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS combat_log_entries_encounter_id_idx ON combat_log_entries(encounter_id, created_at);
