CREATE TABLE IF NOT EXISTS effect_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effect_key text NOT NULL UNIQUE,
  name text NOT NULL,
  source_type text NOT NULL,
  source_ref text,
  description text,
  duration_type text,
  duration_rounds integer,
  requires_concentration boolean NOT NULL DEFAULT false,
  is_condition boolean NOT NULL DEFAULT false,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS effect_modifiers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  effect_id uuid NOT NULL REFERENCES effect_definitions(id) ON DELETE CASCADE,
  target text NOT NULL,
  modifier_type text NOT NULL,
  value_expression text,
  condition_expression text,
  priority integer NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS effect_modifiers_effect_id_idx
  ON effect_modifiers(effect_id);

CREATE TABLE IF NOT EXISTS active_character_effects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  character_id uuid NOT NULL REFERENCES characters(id) ON DELETE CASCADE,
  effect_id uuid NOT NULL REFERENCES effect_definitions(id) ON DELETE CASCADE,
  source_character_id uuid REFERENCES characters(id) ON DELETE SET NULL,
  remaining_rounds integer,
  expires_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(character_id, effect_id)
);

CREATE INDEX IF NOT EXISTS active_character_effects_character_id_idx
  ON active_character_effects(character_id);

CREATE TABLE IF NOT EXISTS character_exhaustion (
  character_id uuid PRIMARY KEY REFERENCES characters(id) ON DELETE CASCADE,
  exhaustion_level integer NOT NULL DEFAULT 0 CHECK (exhaustion_level BETWEEN 0 AND 6),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO effect_definitions (effect_key, name, source_type, source_ref, description, duration_type, requires_concentration, is_condition, sort_order)
VALUES
  ('condition_blinded', 'Blinded', 'condition', 'condition.blinded', 'Cannot see; fails sight checks; attacks against have advantage; own attacks have disadvantage.', 'variable', false, true, 10),
  ('condition_charmed', 'Charmed', 'condition', 'condition.charmed', 'Cannot attack charmer; charmer has advantage on social checks.', 'variable', false, true, 20),
  ('condition_deafened', 'Deafened', 'condition', 'condition.deafened', 'Cannot hear; fails hearing checks.', 'variable', false, true, 30),
  ('condition_frightened', 'Frightened', 'condition', 'condition.frightened', 'Disadvantage on checks and attacks while source is visible; cannot move closer.', 'variable', false, true, 40),
  ('condition_grappled', 'Grappled', 'condition', 'condition.grappled', 'Speed becomes 0 and speed bonuses do not apply.', 'variable', false, true, 50),
  ('condition_incapacitated', 'Incapacitated', 'condition', 'condition.incapacitated', 'Cannot take actions or reactions.', 'variable', false, true, 60),
  ('condition_invisible', 'Invisible', 'condition', 'condition.invisible', 'Attacks have advantage; attacks against have disadvantage.', 'variable', false, true, 70),
  ('condition_paralysed', 'Paralysed', 'condition', 'condition.paralysed', 'Incapacitated, cannot move/speak, fails STR/DEX saves, attacks against have advantage.', 'variable', false, true, 80),
  ('condition_petrified', 'Petrified', 'condition', 'condition.petrified', 'Incapacitated, resistant to damage, immune to poison/disease, fails STR/DEX saves.', 'variable', false, true, 90),
  ('condition_poisoned', 'Poisoned', 'condition', 'condition.poisoned', 'Disadvantage on attack rolls and ability checks.', 'variable', false, true, 100),
  ('condition_prone', 'Prone', 'condition', 'condition.prone', 'Crawling only unless standing; own attacks have disadvantage.', 'variable', false, true, 110),
  ('condition_restrained', 'Restrained', 'condition', 'condition.restrained', 'Speed 0; own attacks and DEX saves have disadvantage; attacks against have advantage.', 'variable', false, true, 120),
  ('condition_stunned', 'Stunned', 'condition', 'condition.stunned', 'Incapacitated, cannot move, fails STR/DEX saves, attacks against have advantage.', 'variable', false, true, 130),
  ('condition_unconscious', 'Unconscious', 'condition', 'condition.unconscious', 'Incapacitated, prone, fails STR/DEX saves, attacks against have advantage.', 'variable', false, true, 140),
  ('rage', 'Rage', 'class_feature', 'barbarian.rage', 'Advantage on STR checks/saves, melee STR damage bonus, B/P/S resistance, blocks spellcasting.', 'timed', false, false, 200),
  ('bless', 'Bless', 'spell', 'spell.bless', 'Add 1d4 to attack rolls and saving throws.', 'concentration', true, false, 210),
  ('haste', 'Haste', 'spell', 'spell.haste', 'Double speed, +2 AC, advantage on DEX saves, restricted extra action.', 'concentration', true, false, 220),
  ('shield_spell', 'Shield', 'spell', 'spell.shield', '+5 AC until start of next turn and immunity to Magic Missile.', 'until_start_of_next_turn', false, false, 230),
  ('dodge', 'Dodge', 'combat_state', 'action.dodge', 'Attacks against have disadvantage; advantage on DEX saves.', 'until_start_of_next_turn', false, false, 300),
  ('half_cover', 'Half Cover', 'environment', 'cover.half', '+2 AC and +2 DEX saves.', 'while_applicable', false, false, 310),
  ('three_quarters_cover', 'Three-Quarters Cover', 'environment', 'cover.three_quarters', '+5 AC and +5 DEX saves.', 'while_applicable', false, false, 320),
  ('total_cover', 'Total Cover', 'environment', 'cover.total', 'Cannot be targeted directly.', 'while_applicable', false, false, 330)
ON CONFLICT (effect_key) DO UPDATE
SET name = EXCLUDED.name,
    source_type = EXCLUDED.source_type,
    source_ref = EXCLUDED.source_ref,
    description = EXCLUDED.description,
    duration_type = EXCLUDED.duration_type,
    requires_concentration = EXCLUDED.requires_concentration,
    is_condition = EXCLUDED.is_condition,
    sort_order = EXCLUDED.sort_order;

WITH modifier_rows(effect_key, target, modifier_type, value_expression, priority) AS (
  VALUES
    ('condition_blinded', 'ability_check.sight', 'block', NULL, 0),
    ('condition_blinded', 'attack_roll.all', 'disadvantage', NULL, 0),
    ('condition_poisoned', 'attack_roll.all', 'disadvantage', NULL, 0),
    ('condition_poisoned', 'ability_check.all', 'disadvantage', NULL, 0),
    ('condition_grappled', 'speed.all', 'set', '0', 0),
    ('condition_restrained', 'speed.all', 'set', '0', 0),
    ('condition_restrained', 'attack_roll.all', 'disadvantage', NULL, 0),
    ('condition_restrained', 'saving_throw.dex', 'disadvantage', NULL, 0),
    ('condition_prone', 'attack_roll.all', 'disadvantage', NULL, 0),
    ('condition_incapacitated', 'action.standard', 'block', NULL, 0),
    ('condition_incapacitated', 'action.reaction', 'block', NULL, 0),
    ('rage', 'ability_check.str', 'advantage', NULL, 0),
    ('rage', 'saving_throw.str', 'advantage', NULL, 0),
    ('rage', 'damage_roll.melee_weapon.str', 'bonus', 'rage_damage_bonus', 0),
    ('rage', 'damage_taken.bludgeoning', 'resistance', NULL, 0),
    ('rage', 'damage_taken.piercing', 'resistance', NULL, 0),
    ('rage', 'damage_taken.slashing', 'resistance', NULL, 0),
    ('rage', 'spellcasting', 'block', NULL, 0),
    ('rage', 'concentration', 'block', NULL, 0),
    ('bless', 'attack_roll.all', 'extra_die', '1d4', 0),
    ('bless', 'saving_throw.all', 'extra_die', '1d4', 0),
    ('haste', 'speed.all', 'multiplier', '2', 0),
    ('haste', 'ac', 'bonus', '2', 0),
    ('haste', 'saving_throw.dex', 'advantage', NULL, 0),
    ('haste', 'action.extra.haste', 'grant', 'attack_one_weapon_attack,dash,disengage,hide,use_object', 0),
    ('shield_spell', 'ac', 'bonus', '5', 0),
    ('shield_spell', 'spell.magic_missile', 'immunity', NULL, 0),
    ('dodge', 'saving_throw.dex', 'advantage', NULL, 0),
    ('half_cover', 'ac', 'bonus', '2', 0),
    ('half_cover', 'saving_throw.dex', 'bonus', '2', 0),
    ('three_quarters_cover', 'ac', 'bonus', '5', 0),
    ('three_quarters_cover', 'saving_throw.dex', 'bonus', '5', 0),
    ('total_cover', 'visibility.targeting', 'block', NULL, 0)
)
INSERT INTO effect_modifiers (effect_id, target, modifier_type, value_expression, priority)
SELECT effect_definitions.id, modifier_rows.target, modifier_rows.modifier_type, modifier_rows.value_expression, modifier_rows.priority
FROM modifier_rows
JOIN effect_definitions ON effect_definitions.effect_key = modifier_rows.effect_key
WHERE NOT EXISTS (
  SELECT 1
  FROM effect_modifiers
  WHERE effect_modifiers.effect_id = effect_definitions.id
    AND effect_modifiers.target = modifier_rows.target
    AND effect_modifiers.modifier_type = modifier_rows.modifier_type
    AND COALESCE(effect_modifiers.value_expression, '') = COALESCE(modifier_rows.value_expression, '')
);
