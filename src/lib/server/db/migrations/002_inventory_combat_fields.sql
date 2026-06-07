ALTER TABLE character_inventory_items
  ADD COLUMN IF NOT EXISTS location text NOT NULL DEFAULT 'backpack',
  ADD COLUMN IF NOT EXISTS is_equipment boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS to_hit_bonus integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS damage_bonus integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS attack_ability text NOT NULL DEFAULT 'str',
  ADD COLUMN IF NOT EXISTS damage_rolls text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS effects text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS item_source text NOT NULL DEFAULT 'freeform',
  ADD COLUMN IF NOT EXISTS source_item_id uuid;
