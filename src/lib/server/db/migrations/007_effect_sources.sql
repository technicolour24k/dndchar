CREATE TABLE IF NOT EXISTS effect_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effect_id uuid NOT NULL REFERENCES effect_definitions(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  source_ref text NOT NULL,
  source_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(effect_id, source_ref)
);

CREATE INDEX IF NOT EXISTS effect_sources_source_ref_idx
  ON effect_sources(source_ref);

INSERT INTO effect_sources (effect_id, source_type, source_ref, source_name)
SELECT id, source_type, source_ref, name
FROM effect_definitions
WHERE source_ref IS NOT NULL
ON CONFLICT (effect_id, source_ref) DO NOTHING;
