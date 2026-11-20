ALTER TABLE character_inventory_items
  ADD COLUMN IF NOT EXISTS proficient boolean NOT NULL DEFAULT true;
