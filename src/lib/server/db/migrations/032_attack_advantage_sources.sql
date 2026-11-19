-- VTT batch 2, advantage: lets "attack rolls made AGAINST this creature" be a real modifier
-- target, and seeds the standard 5e condition mechanics onto the existing condition Containers.
--
-- Why this lives in Containers: modifier-primacy says a Container only points at Modifiers, it
-- never invents its own mechanics. So rather than a hard-coded condition table in JS, Blinded,
-- Prone, Dodge etc. each get ordinary Modifier links here, and the VTT simply resolves the
-- Containers that a token's conditions point at.
--
-- Side effect worth knowing about: Invisible (attack_roll.all advantage) and Frightened
-- (attack_roll.all and ability_check.all disadvantage) are attacker-side, so they now also affect
-- sheet attack rolls (and, for Frightened, ability checks) when that condition is active on the
-- sheet. Saving throws are deliberately untouched. That is intended.
--
-- A DM can retune any of this in /admin/rules. Not modelled: Frightened's line-of-sight clause
-- (it is seeded unconditional), Paralysed/Unconscious auto-crits within 5 ft, and hidden or
-- obscured states.
--
-- Additive and idempotent: every insert is guarded, and it is a no-op where the Container rows
-- are missing. No down-migration. To roll back, delete these links and ARCHIVE (never delete)
-- the definitions and targets.

-- 1. Targets. No ranged_weapon key yet: rollAttack is melee-only for now.
INSERT INTO modifier_targets (target_key, label, category, value_kind, runtime_supported, description, is_system)
VALUES
  ('attacks_against.all', 'Attack Rolls Against (this creature)', 'combat', 'dice', true,
    'Modifiers on the creature being attacked. Advantage here gives the attacker advantage.', true),
  ('attacks_against.weapon', 'Attack Rolls Against (this creature)', 'combat', 'dice', true,
    'Modifiers on the creature being attacked. Advantage here gives the attacker advantage.', true),
  ('attacks_against.melee_weapon', 'Attack Rolls Against (this creature)', 'combat', 'dice', true,
    'Modifiers on the creature being attacked. Advantage here gives the attacker advantage.', true),
  ('attacks_against.spell', 'Attack Rolls Against (this creature)', 'combat', 'dice', true,
    'Modifiers on the creature being attacked. Advantage here gives the attacker advantage.', true)
ON CONFLICT (target_key) DO NOTHING;

-- 2. Shared definitions (blank value). Only inserted when no non-archived one exists; the existing
--    attack_roll.all disadvantage is reused by target and type, never by id.
INSERT INTO modifier_definitions (target, modifier_type, default_value_expression, is_system)
SELECT wanted.target, wanted.modifier_type, NULL, true
FROM (VALUES
  ('attacks_against.all', 'advantage'),
  ('attacks_against.all', 'disadvantage'),
  ('attack_roll.all', 'advantage'),
  ('ability_check.all', 'disadvantage')
) AS wanted(target, modifier_type)
WHERE NOT EXISTS (
  SELECT 1 FROM modifier_definitions existing
  WHERE existing.target = wanted.target
    AND existing.modifier_type = wanted.modifier_type
    AND COALESCE(existing.default_value_expression, '') = ''
    AND NOT existing.is_archived
)
ON CONFLICT DO NOTHING;

-- 3. Links onto the condition Containers (carried, priority 0). Joined on content_key, so a
--    missing Container simply produces no rows.
INSERT INTO content_modifier_links (content_id, modifier_id, activation_type, condition_expression, priority, sort_order)
SELECT container.id, modifier.id, 'carried', NULLIF(wanted.condition_expression, ''), 0, 0
FROM (VALUES
  ('condition:condition_blinded',     'attacks_against.all', 'advantage',    ''),
  ('condition:condition_invisible',   'attack_roll.all',     'advantage',    ''),
  ('condition:condition_invisible',   'attacks_against.all', 'disadvantage', ''),
  ('condition:condition_paralyzed',   'attacks_against.all', 'advantage',    ''),
  ('condition:condition_paralysed',   'attacks_against.all', 'advantage',    ''),
  ('condition:condition_petrified',   'attacks_against.all', 'advantage',    ''),
  ('condition:condition_prone',       'attacks_against.all', 'advantage',    'within:5'),
  ('condition:condition_prone',       'attacks_against.all', 'disadvantage', 'beyond:5'),
  ('condition:condition_restrained',  'attacks_against.all', 'advantage',    ''),
  ('condition:condition_stunned',     'attacks_against.all', 'advantage',    ''),
  ('condition:condition_unconscious', 'attacks_against.all', 'advantage',    ''),
  ('condition:condition_frightened',  'attack_roll.all',     'disadvantage', ''),
  ('condition:condition_frightened',  'ability_check.all',   'disadvantage', ''),
  ('condition:dodge',                 'attacks_against.all', 'disadvantage', '')
) AS wanted(content_key, target, modifier_type, condition_expression)
JOIN content_definitions container
  ON container.content_key = wanted.content_key
 AND container.content_type = 'condition'
 AND container.owner_user_id IS NULL
 AND NOT container.is_archived
-- Exactly ONE blank definition per target + type (oldest first), so a database that somehow has
-- two can never double-link a condition and count it as two sources.
JOIN LATERAL (
  SELECT candidate.id
  FROM modifier_definitions candidate
  WHERE candidate.target = wanted.target
    AND candidate.modifier_type = wanted.modifier_type
    AND COALESCE(candidate.default_value_expression, '') = ''
    AND NOT candidate.is_archived
  ORDER BY candidate.created_at, candidate.id
  LIMIT 1
) modifier ON true
WHERE NOT EXISTS (
  SELECT 1 FROM content_modifier_links existing
  WHERE existing.content_id = container.id
    AND existing.modifier_id = modifier.id
    AND existing.activation_type = 'carried'
    AND COALESCE(existing.condition_expression, '') = wanted.condition_expression
    AND existing.value_override_expression IS NULL
)
ON CONFLICT DO NOTHING;
