-- Find tables belong to a campaign (campaign system, Unit G). Supersedes the "global until
-- campaigns exist" note in 033.
--
-- Every find table belongs to exactly one campaign. There are no shared or global tables. A campaign
-- with no active table that has something pickable has foraging DISABLED for its characters (the
-- app checks this, nothing here enforces it). Who may edit a table is decided in the app: the
-- primary DM or co-DM of its campaign, or a site admin. owner_user_id stays as provenance ("who
-- wrote it") and no longer grants edit rights.
--
-- Existing tables (archived ones too) move into the migrated Main Campaign, found by the fixed id
-- 035 gave it. If that campaign is missing and any table has no campaign, this refuses to run
-- rather than guess.
--
-- finds.campaign_id records the campaign a forage ran in. It is nullable: finds made before
-- campaigns existed stay NULL.
--
-- The one-active-table rule becomes per campaign: one active table per campaign + area type +
-- category. Idempotent, no down-migration (rollback: drop the two columns and the new index, then
-- recreate find_tables_area_category_active_idx; that needs any duplicate active area + category tables across campaigns archived first).

ALTER TABLE find_tables ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id);

UPDATE find_tables SET campaign_id = '00000000-0000-4000-8000-000000000001'
WHERE campaign_id IS NULL AND EXISTS (SELECT 1 FROM campaigns WHERE id = '00000000-0000-4000-8000-000000000001');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM find_tables WHERE campaign_id IS NULL) THEN
    RAISE EXCEPTION 'Cannot move find tables into a campaign: the Main Campaign (00000000-0000-4000-8000-000000000001) does not exist. Create or restore it, then run this migration again.';
  END IF;
END $$;

ALTER TABLE find_tables ALTER COLUMN campaign_id SET NOT NULL;

ALTER TABLE finds ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id);

-- Backfill: a find that points at a table gets that table's campaign. Table-less finds stay NULL.
UPDATE finds f SET campaign_id = t.campaign_id FROM find_tables t WHERE f.find_table_id = t.id AND f.campaign_id IS NULL;

DROP INDEX IF EXISTS find_tables_area_category_active_idx;
CREATE UNIQUE INDEX IF NOT EXISTS find_tables_campaign_area_category_active_idx
  ON find_tables (campaign_id, area_type, category) WHERE is_archived = false;
