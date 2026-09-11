-- Changes the DEFAULT for theme_background_color so a fresh account gets
-- the app's new dark background (see vtt-sheet-punch-list items 5/6)
-- instead of the old light one. Deliberately does NOT touch any existing
-- row - 013_user_theme_preferences.sql's ADD COLUMN ... DEFAULT already
-- backfilled every existing user with '#f1f1f1' as their actual saved
-- value, and that is their data to keep unless they change it themselves.
ALTER TABLE users
  ALTER COLUMN theme_background_color SET DEFAULT '#14161b';
