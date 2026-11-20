-- Stale-save guard for the whole-sheet Save (campaign system, Unit C).
--
-- Now that a campaign DM or the site admin can edit someone else's sheet, two people can have the
-- same sheet open. sheet_version is a plain counter that ONLY whole-sheet writes bump (the sheet's
-- Save and a version restore). The sheet posts the number it loaded; updateCharacter refuses the
-- save if the row has moved on.
--
-- It is a separate column rather than updated_at on purpose: updated_at is also bumped by action
-- effects, is a timestamptz with microseconds (a JS Date round-trip would lose them), and button
-- actions, forage finds and VTT HP changes must NOT make the owner's open sheet refuse its next Save.
--
-- Note: this takes migration number 036, so the find-tables migration planned for Unit G becomes 037.

ALTER TABLE characters ADD COLUMN IF NOT EXISTS sheet_version integer NOT NULL DEFAULT 0;
