CREATE TABLE IF NOT EXISTS app_settings (
  key text PRIMARY KEY,
  value_json jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO app_settings (key, value_json)
VALUES ('registration_enabled', 'false'::jsonb)
ON CONFLICT (key) DO NOTHING;
