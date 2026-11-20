-- Find tables: each entry gets a chance percent, rolled independently (Rev 6 of the forage plan).
--
-- Before: find_table_entries.weight was a relative weight, picked from by a per-table "type die"
-- that decided how many distinct items came out. After: every entry carries its own chance (a
-- percent from a fixed list) and a successful forage rolls each pickable entry on its own,
-- d100 <= chance. The table's type die is gone.
--
-- Allowed chances: 0 (Off, never found, the way a DM switches an entry off without deleting it),
-- 1 (Ultra Rare), 5 (Very Rare), 10 (Rare), 20 (Uncommon), 30 (Common), 50 (Very Common) and
-- 100 (Guaranteed). The app shows these as a dropdown.
--
-- ASSUMES NO PROD FORAGE DATA: forage (migrations 031+) has never been deployed, so only local
-- data exists and the conversion below is deliberately crude. Weight 0 stays 0 (Off); any other
-- weight becomes 30 (Common). Do not reuse this pattern on data that matters.
--
-- Idempotent: guarded on the old weight column existing. No down-migration (rollback: rename
-- chance back to weight, drop the chance check, add the weight check, re-add find_tables.type_die
-- NOT NULL with a default).

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = 'find_table_entries' AND column_name = 'weight'
  ) THEN
    -- Drop the old 0..1000 check first, so the converted values are not judged against it.
    ALTER TABLE find_table_entries DROP CONSTRAINT IF EXISTS find_table_entries_weight_check;
    ALTER TABLE find_table_entries RENAME COLUMN weight TO chance;
    UPDATE find_table_entries SET chance = 30 WHERE chance <> 0;
    ALTER TABLE find_table_entries ALTER COLUMN chance SET DEFAULT 30;
    ALTER TABLE find_table_entries
      ADD CONSTRAINT find_table_entries_chance_check CHECK (chance IN (0, 1, 5, 10, 20, 30, 50, 100));
  END IF;
END $$;

ALTER TABLE find_tables DROP COLUMN IF EXISTS type_die;
