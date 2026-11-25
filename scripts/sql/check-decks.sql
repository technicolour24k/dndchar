-- Read-only pre-flight for the decks migrations (047 deck schema, 048 seed). Run it against a database before
-- migrating; it changes nothing.
--   psql "$DATABASE_URL" -f scripts/sql/check-decks.sql

-- content_type values in use (047 re-creates the CHECK with 'deck' added; every value here must stay allowed).
SELECT content_type, count(*) FROM content_definitions GROUP BY content_type ORDER BY content_type;

-- expiry_boundary values in use (046 added 'next_attack'; 048's conditions use round_end and next_attack).
SELECT 'content_definitions' AS source, expiry_boundary, count(*) FROM content_definitions GROUP BY expiry_boundary
UNION ALL
SELECT 'active_character_effects', expiry_boundary, count(*) FROM active_character_effects GROUP BY expiry_boundary
ORDER BY 1, 2;

-- Any existing deck or deck-condition keys (048 only inserts what is missing, so these should be empty before it runs).
SELECT content_key, content_type, is_archived FROM content_definitions
WHERE content_key LIKE 'deck:%' OR content_key LIKE 'condition:deck_fate_%' ORDER BY content_key;

-- The shared modifier definitions 048 reuses (it inserts a blank one only when none exists and is not archived).
SELECT target, modifier_type, default_value_expression, is_system, is_archived FROM modifier_definitions
WHERE (target = 'ac' AND modifier_type = 'bonus') OR (target = 'attack_roll.all' AND modifier_type IN ('bonus', 'advantage', 'disadvantage'))
ORDER BY target, modifier_type, is_system DESC, created_at;
