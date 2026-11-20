-- 020_archive_nonmechanical_effects.sql
-- Archives SRD-imported effect_definitions rows that carry no mechanical weight:
-- no modifiers attached, not a D&D condition, not manually marked selectable,
-- not homebrew, not referenced by any active character or content link.
-- Syncs the archive state to the corresponding content_definitions rows added in 019.

UPDATE effect_definitions
SET is_archived = true
WHERE is_selectable = false
  AND is_condition  = false
  AND COALESCE(is_homebrew, false) = false
  AND NOT EXISTS (
    SELECT 1 FROM effect_modifier_links
    WHERE effect_modifier_links.effect_id = effect_definitions.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM active_character_effects
    WHERE active_character_effects.effect_id = effect_definitions.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM content_effect_links
    WHERE content_effect_links.effect_id = effect_definitions.id
  );

-- Mirror the archive state to content_definitions (migrated in 019).
UPDATE content_definitions cd
SET is_archived = true
FROM effect_definitions ed
WHERE cd.content_key  = 'condition:' || ed.effect_key
  AND cd.content_type = 'condition'
  AND ed.is_archived  = true;