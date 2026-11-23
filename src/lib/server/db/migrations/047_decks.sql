-- Decks unit 4 (plans/dndchar/decks). Additive and idempotent.
-- A deck is a Container: a content_definitions row with content_type 'deck' plus a 1:1 deck_definitions
-- row holding its rules JSON (cards with tags, a success table, outcome templates; see
-- src/lib/rules/decks.ts). Rules are data, so no per-deck code.
--  * campaign_decks: which global decks a campaign has enabled (the DM picks; selection, not authoring).
--  * deck_draws: one row per draw. It stores ids, tags and the deltas that were actually applied
--    (results), never what a modifier does (presence is historical, mechanics current). The drawn card
--    is snapshotted in card_json so a later edit of the deck cannot change an old draw.
-- Decks are archive-only (draws reference them with no cascade).
-- To roll back: drop deck_draws, campaign_decks and deck_definitions (needs no 'deck' content rows),
-- then restore the six-value content_type CHECK from 019.

DO $$
BEGIN
  ALTER TABLE content_definitions DROP CONSTRAINT IF EXISTS content_definitions_content_type_check;
  ALTER TABLE content_definitions ADD CONSTRAINT content_definitions_content_type_check
    CHECK (content_type IN ('item', 'spell', 'feat', 'class_feature', 'condition', 'action', 'deck'));
END $$;

CREATE TABLE IF NOT EXISTS deck_definitions (
  content_id uuid PRIMARY KEY REFERENCES content_definitions(id) ON DELETE RESTRICT,
  rules_json jsonb NOT NULL CHECK (jsonb_typeof(rules_json) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS campaign_decks (
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  deck_content_id uuid NOT NULL REFERENCES content_definitions(id) ON DELETE RESTRICT,
  is_enabled boolean NOT NULL DEFAULT true,
  added_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, deck_content_id)
);

CREATE TABLE IF NOT EXISTS deck_draws (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deck_content_id uuid NOT NULL REFERENCES content_definitions(id),
  campaign_id uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  drawer_character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  drawer_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  room_code text,
  game_session_id uuid REFERENCES game_sessions(id) ON DELETE SET NULL,
  -- The expanded card as drawn: id, label, tags, value, valueOptions.
  card_json jsonb NOT NULL,
  success boolean NOT NULL,
  chosen_value integer,
  status text NOT NULL CHECK (status IN ('choosing', 'resolved', 'reverted', 'cancelled')),
  -- Outcome id and name, the text actually shown, the roll breakdowns.
  outcome_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- One entry per applied change: { characterId, kind: coin|hp|temp_hp|condition, coin?, requested, before,
  -- after, effectRowId?, tokenHpDelta?, note? } (tokenHpDelta is written by the VTT announce step in unit 5). Stores what was ACTUALLY applied, which undo reverses.
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- { id, text, characterIds, done, doneByUserId, doneAt }
  dm_tasks jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  reverted_at timestamptz,
  reverted_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  revert_note text NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS deck_draws_campaign_idx ON deck_draws (campaign_id, created_at DESC);
CREATE INDEX IF NOT EXISTS deck_draws_drawer_idx ON deck_draws (drawer_character_id, created_at DESC);
-- One undecided Ace per character, so a redraw cannot dodge it.
CREATE UNIQUE INDEX IF NOT EXISTS deck_draws_one_choosing_idx ON deck_draws (drawer_character_id) WHERE status = 'choosing';
