-- Cost engine unit 2: character resource pools (Soulfire, Vowfire, any DM-defined pool) and the
-- source-attributed ledger of every spend. Additive and idempotent: no backfill and no legacy
-- table touched. Pool state lives in character_resources under the key 'pool:<key>' (rows are
-- lazy: no row means full). To roll back, archive pools (never delete) and drop the ledger.

CREATE TABLE IF NOT EXISTS resource_pool_definitions (
  pool_key text PRIMARY KEY CHECK (
    pool_key ~ '^[a-z][a-z0-9_]{1,39}$'
    AND pool_key NOT IN ('spell_slot','charges','item','action','bonus_action','reaction','hp','temp_hp','inspiration')
  ),
  label text NOT NULL,
  description text NOT NULL DEFAULT '',
  base_max_expression text NOT NULL DEFAULT '0',
  recharge_period text NOT NULL DEFAULT 'long_rest'
    CHECK (recharge_period IN ('short_rest','long_rest','dawn','encounter','manual')),
  show_when_empty boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  is_archived boolean NOT NULL DEFAULT false,
  is_system boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO resource_pool_definitions (pool_key, label, description, base_max_expression, recharge_period, sort_order, is_system)
VALUES
  ('soulfire', 'Soulfire', 'Spent by abilities that burn the soul. Granted by feats; hidden while the maximum is 0.', '0', 'long_rest', 10, true),
  ('vowfire', 'Vowfire', 'Spent by oath-bound abilities. Granted by feats; hidden while the maximum is 0.', '0', 'long_rest', 20, true)
ON CONFLICT (pool_key) DO NOTHING;

INSERT INTO modifier_targets (target_key, label, category, value_kind, runtime_supported, description, is_system)
VALUES
  ('resource.soulfire.max', 'Soulfire (maximum)', 'resource', 'number', true, 'Raises the character''s maximum Soulfire. Sources sum by count.', true),
  ('resource.vowfire.max', 'Vowfire (maximum)', 'resource', 'number', true, 'Raises the character''s maximum Vowfire. Sources sum by count.', true)
ON CONFLICT (target_key) DO NOTHING;

-- The unique shape index is on an expression, so ON CONFLICT can't target it: guard with NOT EXISTS.
INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, label, is_system)
SELECT wanted.target, 'bonus', '1', wanted.label, true
FROM (VALUES
  ('resource.soulfire.max', 'Soulfire (max)'),
  ('resource.vowfire.max', 'Vowfire (max)')
) AS wanted(target, label)
WHERE NOT EXISTS (
  SELECT 1 FROM modifier_definitions existing
  WHERE existing.target = wanted.target
    AND existing.modifier_type = 'bonus'
    AND COALESCE(existing.default_value_expression, '') = '1'
    AND NOT existing.is_archived
)
ON CONFLICT DO NOTHING;

CREATE TABLE IF NOT EXISTS character_resource_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  pool text NOT NULL,
  pool_detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  label text NOT NULL,
  delta integer NOT NULL,
  before_value integer,
  after_value integer,
  shortfall integer NOT NULL DEFAULT 0 CHECK (shortfall >= 0),
  reason text NOT NULL CHECK (reason IN ('cost','manual','rest','refund')),
  source_content_id uuid REFERENCES content_definitions(id) ON DELETE SET NULL,
  source_label text NOT NULL DEFAULT '',
  activation_id uuid,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  override_kind text CHECK (override_kind IN ('dm_approved','dm_self','self_override')),
  approved_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  approval_request_id uuid,
  room_id text,
  reviewed_at timestamptz,
  reviewed_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  review_outcome text CHECK (review_outcome IN ('ok','undone')),
  refund_of uuid REFERENCES character_resource_ledger(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS character_resource_ledger_character_idx
  ON character_resource_ledger (character_id, created_at DESC);
CREATE INDEX IF NOT EXISTS character_resource_ledger_unreviewed_idx
  ON character_resource_ledger (character_id)
  WHERE override_kind = 'self_override' AND reviewed_at IS NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_definitions_cost_json_is_array') THEN
    ALTER TABLE content_definitions ADD CONSTRAINT content_definitions_cost_json_is_array
      CHECK (cost_json IS NULL OR jsonb_typeof(cost_json) = 'array');
  END IF;
END $$;
