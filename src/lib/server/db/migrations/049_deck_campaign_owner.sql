-- Decks unit 9b (plans/dndchar/decks, Rev 4). Additive and idempotent.
-- A deck a DM creates is owned by the campaign and exists only there. deck_definitions.campaign_id is that owner;
-- NULL means a global deck (the seeded Deck of Mystical Fate, read-only: a DM copies it into the campaign to edit).
-- It lives on deck_definitions (deck-only data) rather than content_definitions (shared by every content type).
-- ON DELETE is the default (restrict): decks are archive-only and draws reference them, so a campaign that still
-- owns decks cannot be hard-deleted by accident (campaigns are archived, not deleted, in normal use).
-- To roll back: drop the index and the column (only safe once no campaign-owned decks matter).

ALTER TABLE deck_definitions ADD COLUMN IF NOT EXISTS campaign_id uuid REFERENCES campaigns(id);
CREATE INDEX IF NOT EXISTS deck_definitions_campaign_idx ON deck_definitions (campaign_id) WHERE campaign_id IS NOT NULL;
