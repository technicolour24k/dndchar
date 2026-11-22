-- Action economy unit 2 (plans/dndchar/action-economy). Additive and idempotent.
--  * campaigns.action_economy: which built-in profile the campaign plays by (every campaign starts
--    on dnd5e; the DM switches it on the campaign page).
--  * character_turn_state: what a character has SPENT this turn, one lazy row per character. It is
--    deliberately NOT in character_resources (the whole-sheet Save wipes non-pool rows, snapshots
--    copy that table) and not a resource_pool_definitions row (profiles decide the pools).
--  * modifier targets and definitions for per-turn pool maxima and follow-ups (Extra Attack).
--  * 'turn' and 'followup' join the reserved pool keys.
-- To roll back: drop character_turn_state and campaigns.action_economy; nothing else depends on them.

ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS action_economy text NOT NULL DEFAULT 'dnd5e'
  CHECK (action_economy IN ('dnd5e', 'attack_utility'));

CREATE TABLE IF NOT EXISTS character_turn_state (
  character_id uuid PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  profile_key text NOT NULL,
  turn_seq integer NOT NULL DEFAULT 0 CHECK (turn_seq >= 0),
  spent_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(spent_json) = 'object'),
  followups_json jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(followups_json) = 'object'),
  log_json jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(log_json) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO modifier_targets (target_key, label, category, value_kind, runtime_supported, description, is_system)
VALUES
  ('action_pool.action.max', 'Actions per turn (maximum)', 'action_economy', 'number', true, 'Raises this per-turn pool. Only applies in campaigns whose profile has this pool. Sources sum by count.', true),
  ('action_pool.bonus_action.max', 'Bonus actions per turn (maximum)', 'action_economy', 'number', true, 'Raises this per-turn pool. Only applies in campaigns whose profile has this pool. Sources sum by count.', true),
  ('action_pool.reaction.max', 'Reactions per turn (maximum)', 'action_economy', 'number', true, 'Raises this per-turn pool. Only applies in campaigns whose profile has this pool. Sources sum by count.', true),
  ('action_pool.attack.max', 'Attack actions per turn (maximum)', 'action_economy', 'number', true, 'Raises this per-turn pool. Only applies in campaigns whose profile has this pool. Sources sum by count.', true),
  ('action_pool.utility.max', 'Utility actions per turn (maximum)', 'action_economy', 'number', true, 'Raises this per-turn pool. Only applies in campaigns whose profile has this pool. Sources sum by count.', true),
  ('followup.melee.count', 'Free repeats: melee attacks', 'action_economy', 'number', true, 'Free repeats of the same melee attack after paying its action (Extra Attack). A follow-up waives only the action cost. Sources sum by count.', true),
  ('followup.ranged.count', 'Free repeats: ranged attacks', 'action_economy', 'number', true, 'Free repeats of the same ranged attack after paying its action (Extra Attack). A follow-up waives only the action cost. Sources sum by count.', true),
  ('followup.spell.count', 'Free repeats: spells', 'action_economy', 'number', true, 'Free echoes of the same spell after casting it (doublecast). An echo is completely free and always resolves at the spell''s base level. Sources sum by count.', true),
  ('followup.cantrip.count', 'Free repeats: cantrips', 'action_economy', 'number', true, 'Free echoes of the same cantrip after casting it. An echo is completely free. Sources sum by count.', true),
  ('followup.other.count', 'Free repeats: other actions', 'action_economy', 'number', true, 'Free repeats of the same other action after paying for it. A follow-up waives only the action cost. Sources sum by count.', true)
ON CONFLICT (target_key) DO NOTHING;

-- The unique shape index is on an expression, so ON CONFLICT can't target it: guard with NOT EXISTS
-- (same pattern as 044). Extra Attack is two definitions, melee and ranged, both linked by the
-- feature. Spell and cantrip echoes are authored by a DM when a doublecast feature exists.
INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, label, is_system)
SELECT wanted.target, 'bonus', '1', wanted.label, true
FROM (VALUES
  ('action_pool.action.max', 'Extra Action (per turn)'),
  ('action_pool.bonus_action.max', 'Extra Bonus action (per turn)'),
  ('action_pool.reaction.max', 'Extra Reaction (per turn)'),
  ('action_pool.attack.max', 'Extra Attack action (per turn)'),
  ('action_pool.utility.max', 'Extra Utility action (per turn)'),
  ('followup.melee.count', 'Extra Attack (melee follow-up)'),
  ('followup.ranged.count', 'Extra Attack (ranged follow-up)')
) AS wanted(target, label)
WHERE NOT EXISTS (
  SELECT 1 FROM modifier_definitions existing
  WHERE existing.target = wanted.target
    AND existing.modifier_type = 'bonus'
    AND COALESCE(existing.default_value_expression, '') = '1'
    AND NOT existing.is_archived
)
ON CONFLICT DO NOTHING;

-- 'turn' and 'followup' are now reserved pool keys. The CHECK was created inline in 044, so its name
-- is auto-generated: find it by its definition and recreate it with the longer list.
DO $$
DECLARE
  old_name text;
BEGIN
  SELECT conname INTO old_name FROM pg_constraint
  WHERE conrelid = 'resource_pool_definitions'::regclass AND contype = 'c'
    AND pg_get_constraintdef(oid) LIKE '%pool_key%' AND pg_get_constraintdef(oid) LIKE '%spell_slot%'
    AND pg_get_constraintdef(oid) NOT LIKE '%followup%';
  IF old_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE resource_pool_definitions DROP CONSTRAINT %I', old_name);
    ALTER TABLE resource_pool_definitions ADD CONSTRAINT resource_pool_definitions_pool_key_check CHECK (
      pool_key ~ '^[a-z][a-z0-9_]{1,39}$'
      AND pool_key NOT IN ('spell_slot','charges','item','action','bonus_action','reaction','turn','followup','hp','temp_hp','inspiration')
    );
  END IF;
END $$;
