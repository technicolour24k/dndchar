-- VTT forage: a self-serve player may forage for any area + category, even one with no table.
--
-- Players get no table insight (Rev 4), so the self-serve pickers no longer hint at which
-- combinations have a table. A combination with nothing behind it still rolls and marks like any
-- other, and a pass simply finds nothing. Such a find has no table, so find_table_id becomes
-- nullable, and the finds row keeps the area + category the player picked so the admin review can
-- still say what was searched for.
--
-- DM-mode finds always have a table (the DM picks one), as do all rows written before this.

ALTER TABLE finds ALTER COLUMN find_table_id DROP NOT NULL;

ALTER TABLE finds ADD COLUMN IF NOT EXISTS area_type text NOT NULL DEFAULT '';
ALTER TABLE finds ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT '';

-- Backfill the existing rows from their table.
UPDATE finds f
SET area_type = t.area_type, category = t.category
FROM find_tables t
WHERE t.id = f.find_table_id AND f.area_type = '' AND f.category = '';
