-- Reusable VTT token templates ("save this goblin, spawn it again next
-- session without rebuilding it by hand"). token_json is a snapshot of the
-- reusable subset of a token's fields (type/ac/stats/vision/speed/imageUrl/
-- soundFolder/actions) - never x/y/id/hidden/ownerId, which are per-instance
-- placement details, not part of what makes a "goblin" a goblin.
CREATE TABLE IF NOT EXISTS creature_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS creature_templates_owner_user_id_idx ON creature_templates(owner_user_id);
