ALTER TABLE users
  ADD COLUMN IF NOT EXISTS theme_background_color text NOT NULL DEFAULT '#f1f1f1',
  ADD COLUMN IF NOT EXISTS theme_panel_color text NOT NULL DEFAULT '#292929',
  ADD COLUMN IF NOT EXISTS theme_text_color text NOT NULL DEFAULT '#f4f4f4';
