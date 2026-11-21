-- Overworld maps (overworld-map plan, Unit A): long-lived campaign maps with pins and saved routes.
--
-- overworld_maps       one row per map; the image lives on DISK under <UPLOAD_DIR>/overworld/<campaign_id>/,
--                      this row only stores the bare file name, its sniffed size and the DM-set scale.
-- overworld_pins       pins and "party is here" pins (kind = 'party'), positions as 0..1 fractions of the image.
-- overworld_routes     a saved route (label, colour, visibility) ...
-- overworld_route_legs ... made of one row per leg, so deleting a single leg is a single DELETE.
--
-- The colour and icon keys in the CHECKs below MUST match src/lib/overworld/palette.ts.
-- 039 is reserved by the homebrew-library plan (not built yet); the migration runner applies every
-- unapplied file in sorted order and does not stop at a gap, so 040 landing before 039 is fine.
--
-- Idempotent (IF NOT EXISTS throughout). No down-migration. Rollback, in this order:
--   DROP TABLE overworld_route_legs; DROP TABLE overworld_routes; DROP TABLE overworld_pins; DROP TABLE overworld_maps;
-- then delete <UPLOAD_DIR>/overworld/ by hand if you want the image files gone too.

CREATE TABLE IF NOT EXISTS overworld_maps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  -- Bare file name only (no slashes, no dots-only tricks): <UPLOAD_DIR>/overworld/<campaign_id>/<image_file>
  image_file text NOT NULL CHECK (image_file ~ '^[A-Za-z0-9._-]{1,100}$' AND image_file NOT LIKE '%..%' AND image_file NOT LIKE '.%'),
  image_width int NOT NULL CHECK (image_width BETWEEN 1 AND 6000),
  image_height int NOT NULL CHECK (image_height BETWEEN 1 AND 6000),
  image_bytes int NOT NULL CHECK (image_bytes > 0 AND image_bytes <= 15728640), -- 15 MB upload cap
  -- Miles across the full image width. NULL = no scale set, so no distances shown.
  miles_across double precision CHECK (miles_across IS NULL OR (miles_across > 0 AND miles_across <= 100000)),
  -- NULL = DMs only; set = shared with the party.
  granted_at timestamptz,
  -- Soft delete.
  archived_at timestamptz,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- 20 MP server cap, in bigint so width * height cannot overflow an int.
  CHECK (image_width::bigint * image_height::bigint <= 20000000)
);

CREATE INDEX IF NOT EXISTS overworld_maps_campaign_idx
  ON overworld_maps (campaign_id, created_at) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS overworld_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL REFERENCES overworld_maps(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'pin' CHECK (kind IN ('pin', 'party')),
  x double precision NOT NULL CHECK (x >= 0 AND x <= 1),
  y double precision NOT NULL CHECK (y >= 0 AND y <= 1),
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 60),
  note text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  colour text NOT NULL DEFAULT 'red'
    CHECK (colour IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'white')),
  icon text NOT NULL DEFAULT 'dot'
    CHECK (icon IN ('dot', 'star', 'flag', 'cross', 'question', 'exclaim', 'camp', 'tower')),
  -- Text rather than boolean so a later value can slot in without a type change.
  visibility text NOT NULL DEFAULT 'everyone' CHECK (visibility IN ('everyone', 'private')),
  -- "Added by a DM", frozen at creation (not recomputed from the creator's current role).
  dm_locked boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Party pins are always DM-only.
  CHECK (kind <> 'party' OR dm_locked)
);

CREATE INDEX IF NOT EXISTS overworld_pins_map_idx ON overworld_pins (map_id);

CREATE TABLE IF NOT EXISTS overworld_routes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  map_id uuid NOT NULL REFERENCES overworld_maps(id) ON DELETE CASCADE,
  label text NOT NULL DEFAULT '' CHECK (length(label) <= 60),
  colour text NOT NULL DEFAULT 'white'
    CHECK (colour IN ('red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'white')),
  visibility text NOT NULL DEFAULT 'everyone' CHECK (visibility IN ('everyone', 'private')),
  dm_locked boolean NOT NULL DEFAULT false,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS overworld_routes_map_idx ON overworld_routes (map_id);

CREATE TABLE IF NOT EXISTS overworld_route_legs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  route_id uuid NOT NULL REFERENCES overworld_routes(id) ON DELETE CASCADE,
  -- Order along the route. A deleted middle leg leaves a gap in seq, which is fine.
  seq int NOT NULL CHECK (seq >= 0),
  x1 double precision NOT NULL CHECK (x1 BETWEEN 0 AND 1),
  y1 double precision NOT NULL CHECK (y1 BETWEEN 0 AND 1),
  x2 double precision NOT NULL CHECK (x2 BETWEEN 0 AND 1),
  y2 double precision NOT NULL CHECK (y2 BETWEEN 0 AND 1),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (route_id, seq)
);
