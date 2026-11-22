-- Action economy pre-flight / post-check (read-only). Run before migration 045 (first three rows must be 0)
-- and again after it. Usage: psql "<url>" -c "SET default_transaction_read_only = on" -f scripts/sql/check-action-economy.sql
-- (The campaigns.action_economy column only exists after 045, so drop the last row for the pre-flight run.)
SELECT 'pool named turn or followup (must be 0)' AS check_name, count(*) AS n FROM resource_pool_definitions WHERE pool_key IN ('turn', 'followup')
UNION ALL SELECT 'action_pool/followup targets (expect 0 before 045)', count(*) FROM modifier_targets WHERE target_key LIKE 'action_pool.%' OR target_key LIKE 'followup.%'
UNION ALL SELECT 'character_resources keys starting turn: (must be 0)', count(*) FROM character_resources WHERE resource_key LIKE 'turn:%'
UNION ALL SELECT 'info: explicit costs', count(*) FROM content_definitions WHERE cost_json IS NOT NULL
UNION ALL SELECT 'info: explicit costs with legacy action lines', count(*) FROM content_definitions
  WHERE cost_json IS NOT NULL AND jsonb_path_exists(cost_json, '$[*] ? (@.pool == "action" || @.pool == "bonus_action" || @.pool == "reaction")')
UNION ALL SELECT 'info: explicit costs that will inherit a default turn line', count(*) FROM content_definitions
  WHERE cost_json IS NOT NULL AND NOT jsonb_path_exists(cost_json, '$[*] ? (@.pool == "action" || @.pool == "bonus_action" || @.pool == "reaction" || @.pool == "turn")')
UNION ALL SELECT 'info: campaigns', count(*) FROM campaigns WHERE NOT is_archived;
