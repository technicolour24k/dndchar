ALTER TABLE characters ADD COLUMN IF NOT EXISTS active_vtt_session_id text;

CREATE TABLE IF NOT EXISTS roll_log_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id text NOT NULL,
  message text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS roll_log_entries_session_id_idx ON roll_log_entries(session_id, created_at);
