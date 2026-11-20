-- Campaigns: a campaign owns members, characters (the party), game sessions and one long-lived
-- VTT room (the room itself lives in memory; only its fixed code is stored here).
--
-- Roles (campaign_members.role): 'dm' is the PRIMARY DM, 'co_dm' is the single co-DM, 'player' is
-- everyone else. At most one of each of 'dm' and 'co_dm' per campaign is enforced by the two partial
-- unique indexes below; the service checks first so people get a friendly message. Site admin is
-- NOT a role: it is an override applied in the access rules, never stored here.
--
-- One campaign per character is the nullable characters.campaign_id column. "The owner must be a
-- member of the character's campaign" is cross-table, so the service enforces it (and releases a
-- member's characters when they leave or are removed).
--
-- Codes use the VTT room-code alphabet (no I, O, 0, 1): invite_code is 10 characters, room_code is
-- 8 (ad-hoc "Quick room" codes are 6, so the two can never collide).
--
-- Campaigns are archive-only, never hard-deleted by the app. Archiving releases the characters.
--
-- The migration also creates ONE empty campaign, 'Main Campaign', with the fixed id
-- 00000000-0000-4000-8000-000000000001: no members, no characters. An admin assigns its DMs.
-- Migration 037 (find tables; 036 is the sheet-version column) moves existing data into it by this id.

CREATE TABLE IF NOT EXISTS campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  description text NOT NULL DEFAULT '' CHECK (length(description) <= 2000),
  invite_code text NOT NULL UNIQUE CHECK (invite_code ~ '^[A-HJ-NP-Z2-9]{10}$'),
  room_code text NOT NULL UNIQUE CHECK (room_code ~ '^[A-HJ-NP-Z2-9]{8}$'),
  -- Provenance only. "Primary DM" is the role, which can move. NULL for the migrated campaign.
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- List sort and name search.
CREATE INDEX IF NOT EXISTS campaigns_name_idx ON campaigns (lower(name));

CREATE TABLE IF NOT EXISTS campaign_members (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('dm', 'co_dm', 'player')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_id)
);

CREATE INDEX IF NOT EXISTS campaign_members_user_idx ON campaign_members (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS campaign_members_one_dm_idx ON campaign_members (campaign_id) WHERE role = 'dm';
CREATE UNIQUE INDEX IF NOT EXISTS campaign_members_one_co_dm_idx ON campaign_members (campaign_id) WHERE role = 'co_dm';

ALTER TABLE characters ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;
ALTER TABLE characters ADD COLUMN IF NOT EXISTS party_active boolean NOT NULL DEFAULT true;
CREATE INDEX IF NOT EXISTS characters_campaign_idx ON characters (campaign_id) WHERE campaign_id IS NOT NULL;

ALTER TABLE game_sessions ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS game_sessions_campaign_idx ON game_sessions (campaign_id, created_at) WHERE campaign_id IS NOT NULL;

-- The migrated campaign, only if there are no campaigns at all. Codes are generated here with
-- pgcrypto (256 is a multiple of 32, so the byte-modulo pick is uniform).
INSERT INTO campaigns (id, name, invite_code, room_code)
SELECT
  '00000000-0000-4000-8000-000000000001',
  'Main Campaign',
  (SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', get_byte(gen_random_bytes(1), 0) % 32 + 1, 1), '') FROM generate_series(1, 10)),
  (SELECT string_agg(substr('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', get_byte(gen_random_bytes(1), 0) % 32 + 1, 1), '') FROM generate_series(1, 8))
WHERE NOT EXISTS (SELECT 1 FROM campaigns)
ON CONFLICT (id) DO NOTHING;
