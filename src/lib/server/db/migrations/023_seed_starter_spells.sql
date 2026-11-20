-- VTT Phase 3 (magic) - spec item 4: seed a representative starter set of
-- damage spells (covering attack/save/auto resolution and both cantrip and
-- leveled/upcast scaling), not the group's real prepared list (agreed
-- default per vtt-phase-3-magic-spec.md). Seeded as global, system-owned, SRD
-- content (owner_user_id NULL, is_system=true) - same pattern migration 019
-- already uses for seeded content - so listCatalogue() (no owner filter)
-- surfaces these in every character's "Add a spell..." dropdown immediately.
--
-- Deliberate simplifications, noted rather than silently applied:
-- - Eldritch Blast is modeled as a single beam (no multi-beam-at-higher-level
--   mechanic - resolveSpellDamage supports one attack roll per cast).
-- - Magic Missile and Chromatic Orb are modeled with one combined damage
--   roll rather than separate per-dart/no-choice-of-type mechanics.
-- - Fireball/Burning Hands are seeded with their damage profile only; AoE
--   auto-targeting (spec's optional item 6) is out of scope for this pass,
--   so casting them still goes through the single-target flow.
-- - Cure Wounds and other pure-healing spells are intentionally NOT seeded
--   here - they don't fit the attack/save/auto damage model at all, and
--   already work today via the existing on_cast `healing` Action-step path
--   with no changes needed.

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:fire-bolt', 'spell', 'Fire Bolt', 'You hurl a mote of fire at a creature or object within range.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, scaling_json)
SELECT id, 0, 'Evocation', '1 action', '120 feet', 'V, S', 'Instantaneous', ARRAY['Sorcerer', 'Wizard'],
  'attack', 'fire', '1d10', '{"kind":"cantrip","extraDice":"1d10","tiers":[5,11,17]}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:ray-of-frost', 'spell', 'Ray of Frost', 'A frigid beam of blue-white light streaks toward a creature within range.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, scaling_json)
SELECT id, 0, 'Evocation', '1 action', '60 feet', 'V, S', 'Instantaneous', ARRAY['Sorcerer', 'Wizard'],
  'attack', 'cold', '1d8', '{"kind":"cantrip","extraDice":"1d8","tiers":[5,11,17]}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:sacred-flame', 'spell', 'Sacred Flame', 'Flame-like radiance descends on a creature that you can see within range.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, save_ability, save_effect, scaling_json)
SELECT id, 0, 'Evocation', '1 action', '60 feet', 'V, S', 'Instantaneous', ARRAY['Cleric'],
  'save', 'radiant', '1d8', 'dex', 'negate', '{"kind":"cantrip","extraDice":"1d8","tiers":[5,11,17]}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:eldritch-blast', 'spell', 'Eldritch Blast', 'A beam of crackling energy streaks toward a creature within range.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, scaling_json)
SELECT id, 0, 'Evocation', '1 action', '120 feet', 'V, S', 'Instantaneous', ARRAY['Warlock'],
  'attack', 'force', '1d10', '{"kind":"cantrip","extraDice":"1d10","tiers":[5,11,17]}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:magic-missile', 'spell', 'Magic Missile', 'You create three glowing darts of magical force. Each dart hits a creature of your choice that you can see within range.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, scaling_json)
SELECT id, 1, 'Evocation', '1 action', '120 feet', 'V, S', 'Instantaneous', ARRAY['Sorcerer', 'Wizard'],
  'auto', 'force', '3d4+3', '{"kind":"leveled","extraDicePerSlotLevel":"1d4+1"}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:burning-hands', 'spell', 'Burning Hands', 'A thin sheet of flames shoots forth from your outstretched fingertips.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, save_ability, save_effect, scaling_json)
SELECT id, 1, 'Evocation', '1 action', 'Self (15-foot cone)', 'V, S', 'Instantaneous', ARRAY['Sorcerer', 'Wizard'],
  'save', 'fire', '3d6', 'dex', 'half', '{"kind":"leveled","extraDicePerSlotLevel":"1d6"}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:guiding-bolt', 'spell', 'Guiding Bolt', 'A flash of light streaks toward a creature of your choice within range.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, scaling_json)
SELECT id, 1, 'Evocation', '1 action', '120 feet', 'V, S', '1 round', ARRAY['Cleric'],
  'attack', 'radiant', '4d6', '{"kind":"leveled","extraDicePerSlotLevel":"1d6"}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:chromatic-orb', 'spell', 'Chromatic Orb', 'You hurl a 4-inch-diameter sphere of energy at a creature within range.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, scaling_json)
SELECT id, 1, 'Evocation', '1 action', '90 feet', 'V, S, M', 'Instantaneous', ARRAY['Sorcerer', 'Wizard'],
  'attack', 'acid', '3d8', '{"kind":"leveled","extraDicePerSlotLevel":"1d8"}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:inflict-wounds', 'spell', 'Inflict Wounds', 'Necrotic energy washes through a creature that you touch.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, scaling_json)
SELECT id, 1, 'Necromancy', '1 action', 'Touch', 'V, S', 'Instantaneous', ARRAY['Cleric'],
  'attack', 'necrotic', '3d10', '{"kind":"leveled","extraDicePerSlotLevel":"1d10"}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:fireball', 'spell', 'Fireball', 'A bright streak flashes from your pointing finger to a point you choose, then blossoms with a low roar into an explosion of flame.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, damage_type, base_dice, save_ability, save_effect, scaling_json)
SELECT id, 3, 'Evocation', '1 action', '150 feet', 'V, S, M', 'Instantaneous', ARRAY['Sorcerer', 'Wizard'],
  'save', 'fire', '8d6', 'dex', 'half', '{"kind":"leveled","extraDicePerSlotLevel":"1d6"}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;
