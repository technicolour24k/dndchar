-- Read-only checks for the homebrew library (migration 050 onwards). Changes nothing.
--   psql "$DATABASE_URL" -f scripts/sql/check-library.sql

-- Scope counts by type.
SELECT scope, content_type, count(*) FROM content_definitions GROUP BY scope, content_type ORDER BY scope, content_type;

-- Decks whose deck_definitions.campaign_id mirror disagrees with content_definitions.campaign_id. Must be 0 rows.
SELECT c.id, c.content_key, c.campaign_id AS content_campaign, d.campaign_id AS mirror_campaign
FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id
WHERE c.campaign_id IS DISTINCT FROM d.campaign_id;

-- Action containers whose scope, owner or campaign differs from the entry that links to them. Must be 0 rows.
SELECT parent.content_key AS parent_key, action.content_key AS action_key
FROM content_action_links l
JOIN content_definitions parent ON parent.id = l.content_id
JOIN content_definitions action ON action.id = l.action_container_id
WHERE parent.scope IS DISTINCT FROM action.scope
   OR parent.owner_user_id IS DISTINCT FROM action.owner_user_id
   OR parent.campaign_id IS DISTINCT FROM action.campaign_id;

-- Unforked leavers: uses by a campaign of a personal entry whose owner is no longer a member of that campaign.
-- Must be 0 rows once the fork on leave ships (its repair script fixes any left over). Covers characters' items,
-- known content, applied effects, enabled decks and find table items.
WITH uses AS (
  SELECT ch.campaign_id, i.source_content_id AS content_id
    FROM character_inventory_items i JOIN characters ch ON ch.id = i.character_id
    WHERE ch.campaign_id IS NOT NULL AND i.source_content_id IS NOT NULL
  UNION
  SELECT ch.campaign_id, ci.content_id
    FROM character_content_instances ci JOIN characters ch ON ch.id = ci.character_id
    WHERE ch.campaign_id IS NOT NULL
  UNION
  SELECT ch.campaign_id, e.container_id
    FROM active_character_effects e JOIN characters ch ON ch.id = e.character_id
    WHERE ch.campaign_id IS NOT NULL
  UNION
  SELECT campaign_id, deck_content_id FROM campaign_decks
  UNION
  SELECT t.campaign_id, fe.item_id
    FROM find_table_entries fe JOIN find_tables t ON t.id = fe.find_table_id
)
SELECT DISTINCT u.campaign_id, c.content_key, c.owner_user_id
FROM uses u JOIN content_definitions c ON c.id = u.content_id
WHERE c.scope = 'personal'
  AND NOT EXISTS (SELECT 1 FROM campaign_members m WHERE m.campaign_id = u.campaign_id AND m.user_id = c.owner_user_id);

-- The owner_user_id FK must be ON DELETE RESTRICT (confdeltype 'r'). Any row here with another value is wrong.
SELECT conname, confdeltype FROM pg_constraint
WHERE contype = 'f' AND conrelid = 'content_definitions'::regclass
  AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'content_definitions'::regclass AND attname = 'owner_user_id')];
