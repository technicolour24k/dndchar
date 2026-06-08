CREATE TABLE IF NOT EXISTS item_categories (
  key text PRIMARY KEY,
  label text NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO item_categories (key, label, sort_order)
VALUES
  ('weapon', 'Weapon', 10),
  ('armor', 'Armor', 20),
  ('shield', 'Shield', 30),
  ('focus', 'Spell Focus', 40),
  ('consumable', 'Consumable', 50),
  ('tool', 'Tool', 60),
  ('gear', 'Adventuring Gear', 70),
  ('treasure', 'Treasure', 80),
  ('junk', 'Junk', 90),
  ('misc', 'Misc', 100)
ON CONFLICT (key) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order;
