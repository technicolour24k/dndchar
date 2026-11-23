-- Homebrew library unit A (plans/dndchar/homebrew-library). Additive and idempotent (a re-run is a no-op).
-- Three ownership scopes for content_definitions:
--   global   - everything that exists today (SRD, seeds, admin content, conditions, the seeded deck).
--   personal - one user's library entry (owner_user_id is that user). Offered to a campaign only while its DM has
--              switched that member's library on (campaign_library_settings; no row means OFF).
--   campaign - owned by campaign_id. Made ONLY by the deck editor (campaign decks) and by the fork-on-leave code
--              (copies of a leaver's content). Never created from scratch for items, spells, feats or conditions.
-- Rules this schema backs:
--   * Visibility gates NEW USE only, never resolution: anything already held, known, applied, enabled or in a
--     find table keeps resolving whatever the scope, so no read of a held row may filter on scope.
--   * Definitions are soft-deleted (archived) only, so every historical reference still resolves. That is why the
--     new foreign keys are RESTRICT: campaigns are archived, not deleted, and owner_user_id stops cascading so a
--     user's deletion can never silently take their content (and everything pointing at it) with it.
--   * Library content is referenced, not copied, while its owner is a member. forked_from_content_id makes the
--     fork on leave idempotent: one campaign copy per original per campaign. Copies have owner_user_id NULL.
--   * Libraries are opt-in per campaign: an absent campaign_library_settings row means off.
-- deck_definitions.campaign_id (049) is now an UNREAD MIRROR of content_definitions.campaign_id. The deck code reads
-- the content_definitions column from this release on; the mirror stays for one release so pre-050 code keeps
-- working, then a later migration drops it.
-- To roll back: archive or promote every personal and fork row first, then drop campaign_library_settings, the three
-- indexes, the five checks and the four columns, and restore the owner_user_id FK with ON DELETE CASCADE.

ALTER TABLE content_definitions
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'global',
  ADD COLUMN IF NOT EXISTS hidden_from_players boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id),
  ADD COLUMN IF NOT EXISTS forked_from_content_id uuid REFERENCES content_definitions(id);

DO $$
DECLARE
  fk record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_definitions_scope_check' AND conrelid = 'content_definitions'::regclass) THEN
    ALTER TABLE content_definitions ADD CONSTRAINT content_definitions_scope_check
      CHECK (scope IN ('global', 'personal', 'campaign'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_definitions_personal_owner_check' AND conrelid = 'content_definitions'::regclass) THEN
    ALTER TABLE content_definitions ADD CONSTRAINT content_definitions_personal_owner_check
      CHECK (scope <> 'personal' OR owner_user_id IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_definitions_campaign_owner_check' AND conrelid = 'content_definitions'::regclass) THEN
    ALTER TABLE content_definitions ADD CONSTRAINT content_definitions_campaign_owner_check
      CHECK ((scope = 'campaign') = (campaign_id IS NOT NULL));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_definitions_forked_campaign_check' AND conrelid = 'content_definitions'::regclass) THEN
    ALTER TABLE content_definitions ADD CONSTRAINT content_definitions_forked_campaign_check
      CHECK (forked_from_content_id IS NULL OR scope = 'campaign');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'content_definitions_hidden_scope_check' AND conrelid = 'content_definitions'::regclass) THEN
    ALTER TABLE content_definitions ADD CONSTRAINT content_definitions_hidden_scope_check
      CHECK (NOT hidden_from_players OR scope IN ('personal', 'campaign'));
  END IF;

  -- owner_user_id: CASCADE -> RESTRICT. The FK is found by column (not by name, in case prod named it differently)
  -- and only swapped while it is not already RESTRICT, so a re-run is a no-op.
  FOR fk IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.contype = 'f' AND c.conrelid = 'content_definitions'::regclass AND c.confdeltype <> 'r'
      AND c.conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'content_definitions'::regclass AND attname = 'owner_user_id')]
  LOOP
    EXECUTE format('ALTER TABLE content_definitions DROP CONSTRAINT %I', fk.conname);
    ALTER TABLE content_definitions ADD CONSTRAINT content_definitions_owner_user_id_fkey
      FOREIGN KEY (owner_user_id) REFERENCES users(id) ON DELETE RESTRICT;
  END LOOP;
END $$;

CREATE INDEX IF NOT EXISTS content_definitions_personal_owner_idx
  ON content_definitions (owner_user_id, content_type) WHERE scope = 'personal';
CREATE INDEX IF NOT EXISTS content_definitions_campaign_idx
  ON content_definitions (campaign_id, content_type) WHERE scope = 'campaign';
-- One copy per original per campaign: this is what makes the fork idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS content_definitions_fork_idx
  ON content_definitions (campaign_id, forked_from_content_id) WHERE forked_from_content_id IS NOT NULL;

-- Backfill: decks a DM made are campaign-owned. Idempotent (only rows not yet moved).
UPDATE content_definitions c SET scope = 'campaign', campaign_id = d.campaign_id
  FROM deck_definitions d
  WHERE d.content_id = c.id AND d.campaign_id IS NOT NULL AND c.campaign_id IS NULL;

-- Which members' libraries a campaign's DM has switched on. A missing row means OFF.
CREATE TABLE IF NOT EXISTS campaign_library_settings (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_enabled boolean NOT NULL,
  updated_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, owner_user_id)
);
