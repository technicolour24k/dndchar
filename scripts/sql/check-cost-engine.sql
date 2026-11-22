-- Cost engine pre-flight / post-check (read-only). Run before migration 044 (first three rows must be 0)
-- and again after it. Usage: psql "<url>" -c "SET default_transaction_read_only = on" -f scripts/sql/check-cost-engine.sql
SELECT 'cost_json already set' AS check_name, count(*) AS n FROM content_definitions WHERE cost_json IS NOT NULL
UNION ALL SELECT 'character_resources keys starting pool:', count(*) FROM character_resources WHERE resource_key LIKE 'pool:%'
UNION ALL SELECT 'existing resource.* targets', count(*) FROM modifier_targets WHERE target_key LIKE 'resource.%'
UNION ALL SELECT 'info: character_resources keys outside hp/temp_hp/inspiration/hit_dice_N', count(*) FROM character_resources
  WHERE resource_key NOT IN ('hp','temp_hp','inspiration') AND resource_key !~ '^hit_dice_[0-9]+$'
UNION ALL SELECT 'info: spend_item steps', count(*) FROM action_steps WHERE step_type='spend_item'
UNION ALL SELECT 'info: spend_resource steps', count(*) FROM action_steps WHERE step_type='spend_resource'
UNION ALL SELECT 'info: spell access rows', count(*) FROM content_spell_access
UNION ALL SELECT 'info: content counters', count(*) FROM content_resource_definitions
UNION ALL SELECT 'info: dawn counters', count(*) FROM content_resource_definitions WHERE recharge_period='dawn'
UNION ALL SELECT 'info: spells', count(*) FROM spell_definitions;
