-- VTT forage / loot finder, unit A: find tables and the finds log.
--
-- Modifier-primacy fit: a find table only POINTS AT existing item Containers
-- (content_definitions with content_type = 'item'). It grants no mechanics and invents no
-- vocabulary, so any logged-in user may author one (see owner_user_id below).
--
-- find_tables.area_type and .category are free text, stored trimmed and lower-cased (the CHECKs
-- enforce it). They are deliberately not item_categories (that list is equipment type and has no
-- plant/ore/gem/scroll), and free text keeps homebrew areas easy ("wave echo cave").
--
-- Tables are archive-only (is_archived), never hard-deleted, because finds rows reference them.
-- One ACTIVE table per area type + category, globally, until campaigns exist. When the campaign
-- system lands, find_tables should gain a campaign_id and campaign-DM scoping, and the unique
-- index below should become per-campaign.
--
-- finds is the log. It stores ids and quantities only, never item names ("quantity/presence is
-- historical, mechanics is current"). Each results line is
--   { "item_id": uuid, "qty": int, "inventory_id": uuid }
-- where qty is the amount ADDED by that find and inventory_id is the character_inventory_items row
-- it landed on. That row may be a newly inserted one OR an existing row the quantity was stacked
-- onto (same source_content_id), so undo reduces by qty rather than deleting blindly. Nothing
-- here is a foreign key to the inventory row: the player can delete it at any time.
--
-- Two modes. 'dm': the DM approved the haul (only logged once approved, so status is 'found' or
-- later). 'self': no DM was present, so the row exists from the moment the check is rolled.
-- Statuses: 'checked' (self-serve, check rolled, not yet marked), 'failed', 'found', 'reverted'.
-- Reverted finds are never deleted. A user can have at most one unmarked 'checked' find at a time.
--
-- Additive and idempotent: every statement is guarded. No down-migration. To roll back, drop
-- finds, find_table_entries, then find_tables.

CREATE TABLE IF NOT EXISTS find_tables (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  area_type text NOT NULL CHECK (area_type = lower(btrim(area_type)) AND length(area_type) BETWEEN 1 AND 40),
  category text NOT NULL CHECK (category = lower(btrim(category)) AND length(category) BETWEEN 1 AND 40),
  type_die integer NOT NULL CHECK (type_die BETWEEN 1 AND 100),
  -- A DM-side reminder only (e.g. "Nature DC 12"). Never shown to players.
  suggested_check text NOT NULL DEFAULT '' CHECK (length(suggested_check) <= 80),
  is_archived boolean NOT NULL DEFAULT false,
  -- Author. SET NULL so deleting a user keeps their tables (admin can still edit them).
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS find_tables_area_category_active_idx
  ON find_tables(area_type, category) WHERE is_archived = false;

CREATE TABLE IF NOT EXISTS find_table_entries (
  find_table_id uuid NOT NULL REFERENCES find_tables(id) ON DELETE CASCADE,
  -- Must be an item Container. Postgres can't CHECK that across tables, so the service enforces it.
  item_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE CASCADE,
  weight integer NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 1000),
  -- Die rolled for quantity. 1 means always one.
  qty_die integer NOT NULL DEFAULT 1 CHECK (qty_die BETWEEN 1 AND 100),
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (find_table_id, item_id)
);

CREATE TABLE IF NOT EXISTS finds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  mode text NOT NULL CHECK (mode IN ('dm', 'self')),
  status text NOT NULL CHECK (status IN ('checked', 'failed', 'found', 'reverted')),
  game_session_id uuid REFERENCES game_sessions(id) ON DELETE SET NULL,
  room_code text,
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  finder_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- No cascade: tables are archive-only.
  find_table_id uuid NOT NULL REFERENCES find_tables(id),
  nat20 boolean NOT NULL DEFAULT false,
  check_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  shared boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  reverted_at timestamptz,
  reverted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revert_note text NOT NULL DEFAULT '',
  CHECK (mode = 'self' OR status IN ('found', 'reverted'))
);

CREATE INDEX IF NOT EXISTS finds_game_session_idx ON finds(game_session_id, created_at);
CREATE INDEX IF NOT EXISTS finds_character_idx ON finds(character_id, created_at);
CREATE INDEX IF NOT EXISTS finds_status_idx ON finds(status, created_at);

-- At most one unmarked self-serve check per user, so it can't be dodged by re-pressing Forage.
CREATE UNIQUE INDEX IF NOT EXISTS finds_one_unmarked_per_user
  ON finds(finder_user_id) WHERE status = 'checked';
