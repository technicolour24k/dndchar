DELETE FROM content_effect_links WHERE activation_type = 'on_use';

DELETE FROM effect_definitions effect
WHERE COALESCE((effect.metadata_json->>'managedByContentAdmin')::boolean, false) = true;

DROP TABLE IF EXISTS content_resource_actions;
DROP TABLE IF EXISTS legacy_effect_modifiers;
DROP TABLE IF EXISTS effect_modifiers;

DROP INDEX IF EXISTS content_definitions_search_idx;
ALTER TABLE content_definitions DROP COLUMN IF EXISTS publication_status;
CREATE INDEX IF NOT EXISTS content_definitions_search_idx
  ON content_definitions(content_type, is_archived, lower(name));
