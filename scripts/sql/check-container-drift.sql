-- Container migration drift check (read-only). Every non-info row should be 0.
-- Local: psql "$DATABASE_URL" -f scripts/sql/check-container-drift.sql
-- Prod:  psql "<url>" -c "SET default_transaction_read_only = on" -f scripts/sql/check-container-drift.sql
WITH cond AS (
  SELECT ed.*, cd.id AS container_id, cd.name AS c_name, cd.description AS c_description,
         cd.is_archived AS c_archived, cd.stack_behavior AS c_stack,
         cd.expiry_boundary AS c_expiry, cd.duration_rounds AS c_rounds
  FROM effect_definitions ed
  LEFT JOIN content_definitions cd
    ON cd.content_type = 'condition' AND cd.content_key = 'condition:' || ed.effect_key
),
act AS (
  SELECT ad.*,
    COALESCE(
      (SELECT min(cal.action_container_id::text)::uuid FROM content_action_links cal
        WHERE cal.action_id = ad.id AND cal.action_container_id IS NOT NULL),
      (SELECT cd.id FROM content_definitions cd WHERE cd.content_type = 'action' AND cd.owner_user_id IS NULL
        AND cd.content_key IN ('action:' || ad.action_key, ad.action_key)
        ORDER BY (cd.content_key = 'action:' || ad.action_key) DESC LIMIT 1)
    ) AS container_id
  FROM action_definitions ad
)
SELECT 'conditions: effect_definitions with no condition container' AS check_name,
       (SELECT count(*) FROM cond WHERE container_id IS NULL) AS n
UNION ALL SELECT 'conditions: mirrored fields differ (name/desc/archived/stack/expiry/rounds)',
       (SELECT count(*) FROM cond WHERE container_id IS NOT NULL AND (
          c_name IS DISTINCT FROM name OR c_description IS DISTINCT FROM COALESCE(description, '')
          OR c_archived IS DISTINCT FROM is_archived OR c_stack IS DISTINCT FROM stack_behavior
          OR c_expiry IS DISTINCT FROM default_expiry_boundary OR c_rounds IS DISTINCT FROM duration_rounds))
UNION ALL SELECT 'conditions: effect_modifier_links missing from content_modifier_links',
       (SELECT count(*) FROM effect_modifier_links eml JOIN cond ON cond.id = eml.effect_id
         WHERE NOT EXISTS (SELECT 1 FROM content_modifier_links cml
           WHERE cml.content_id = cond.container_id AND cml.modifier_id = eml.modifier_id
             AND COALESCE(cml.value_override_expression, '') = COALESCE(eml.value_override_expression, '')
             AND COALESCE(cml.condition_expression, '') = COALESCE(eml.condition_expression, '')
             AND cml.priority = eml.priority))
UNION ALL SELECT 'conditions (info): content_modifier_links on conditions with no legacy link',
       (SELECT count(*) FROM content_modifier_links cml JOIN cond ON cond.container_id = cml.content_id
         WHERE NOT EXISTS (SELECT 1 FROM effect_modifier_links eml
           WHERE eml.effect_id = cond.id AND eml.modifier_id = cml.modifier_id
             AND COALESCE(cml.value_override_expression, '') = COALESCE(eml.value_override_expression, '')
             AND COALESCE(cml.condition_expression, '') = COALESCE(eml.condition_expression, '')
             AND cml.priority = eml.priority))
UNION ALL SELECT 'active effects: container_id IS NULL',
       (SELECT count(*) FROM active_character_effects WHERE container_id IS NULL)
UNION ALL SELECT 'active effects: container_id disagrees with effect_id',
       (SELECT count(*) FROM active_character_effects ace JOIN cond ON cond.id = ace.effect_id
         WHERE ace.container_id IS DISTINCT FROM cond.container_id)
UNION ALL SELECT 'grants: content_effect_links missing from content_grants',
       (SELECT count(*) FROM content_effect_links cel JOIN cond ON cond.id = cel.effect_id
         WHERE NOT EXISTS (SELECT 1 FROM content_grants cg WHERE cg.source_content_id = cel.content_id
           AND cg.granted_content_id = cond.container_id AND cg.activation_type = cel.activation_type))
UNION ALL SELECT 'grants (info): condition content_grants with no content_effect_links row',
       (SELECT count(*) FROM content_grants cg JOIN cond ON cond.container_id = cg.granted_content_id
         WHERE NOT EXISTS (SELECT 1 FROM content_effect_links cel WHERE cel.content_id = cg.source_content_id
           AND cel.effect_id = cond.id AND cel.activation_type = cg.activation_type))
UNION ALL SELECT 'steps: apply/remove steps with effect_id but no condition container',
       (SELECT count(*) FROM action_steps s LEFT JOIN cond ON cond.id = s.effect_id
         WHERE s.effect_id IS NOT NULL AND cond.container_id IS NULL)
UNION ALL SELECT 'actions: action_definitions with no action container',
       (SELECT count(*) FROM act WHERE container_id IS NULL)
UNION ALL SELECT 'actions: content_action_links.action_container_id IS NULL',
       (SELECT count(*) FROM content_action_links WHERE action_container_id IS NULL)
UNION ALL SELECT 'actions: action_steps.container_id IS NULL',
       (SELECT count(*) FROM action_steps WHERE container_id IS NULL)
UNION ALL SELECT 'actions: step container_id disagrees with its action mapping',
       (SELECT count(*) FROM action_steps s JOIN act ON act.id = s.action_id
         WHERE s.container_id IS NOT NULL AND s.container_id IS DISTINCT FROM act.container_id)
UNION ALL SELECT 'actions: link container_id disagrees with its action mapping',
       (SELECT count(*) FROM content_action_links cal JOIN act ON act.id = cal.action_id
         WHERE cal.action_container_id IS NOT NULL AND cal.action_container_id IS DISTINCT FROM act.container_id)
UNION ALL SELECT 'actions: duplicate (content, container, trigger) after mapping',
       (SELECT count(*) FROM (SELECT cal.content_id, act.container_id, cal.trigger_type
         FROM content_action_links cal JOIN act ON act.id = cal.action_id
         GROUP BY 1, 2, 3 HAVING count(*) > 1) d)
UNION ALL SELECT 'info: total effect_definitions', (SELECT count(*) FROM effect_definitions)
UNION ALL SELECT 'info: total action_definitions', (SELECT count(*) FROM action_definitions)
UNION ALL SELECT 'info: effect_sources rows (dropped in the final unit)', (SELECT count(*) FROM effect_sources);
