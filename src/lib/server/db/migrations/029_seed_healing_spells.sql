-- VTT Phase 8 (combat actions modal) - Section 0: seed healing spell data for
-- the new Heal tab. Cure Wounds and Healing Word already exist as catalogue
-- rows, but as content_type='condition' (confirmed against the live DB - not
-- just the migrations): zero content_action_links, zero characters holding
-- them as known/prepared instances. There is no working self-heal pipeline on
-- those rows to preserve, so rather than repurposing them, this seeds brand
-- new content_type='spell' rows, same pattern as 023_seed_starter_spells.sql
-- (global, system-owned, SRD content so listCatalogue() surfaces them
-- immediately in every character's "Add a spell..." dropdown). Both are pure
-- heals: resolution_type='auto' (no attack roll, no save - resolveSpellDamage's
-- auto branch already handles a dice-only profile with no attack/save layer),
-- no damage_type/save_ability/save_effect.

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:cure-wounds', 'spell', 'Cure Wounds', 'A creature you touch regains a number of hit points.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, base_dice, scaling_json)
SELECT id, 1, 'Evocation', '1 action', 'Touch', 'V, S', 'Instantaneous', ARRAY['Bard', 'Cleric', 'Druid', 'Paladin', 'Ranger'],
  'auto', '1d8', '{"kind":"leveled","extraDicePerSlotLevel":"1d8"}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;

WITH ins AS (
  INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, is_system)
  VALUES ('srd:spell:healing-word', 'spell', 'Healing Word', 'A creature of your choice that you can see within range regains hit points.', 'srd', NULL, true)
  ON CONFLICT (content_key) WHERE owner_user_id IS NULL DO NOTHING
  RETURNING id
)
INSERT INTO spell_definitions (content_id, spell_level, school, casting_time, spell_range, components, duration, classes,
  resolution_type, base_dice, scaling_json)
SELECT id, 1, 'Evocation', '1 bonus action', '60 feet', 'V', 'Instantaneous', ARRAY['Bard', 'Cleric', 'Druid'],
  'auto', '1d4', '{"kind":"leveled","extraDicePerSlotLevel":"1d4"}'::jsonb
FROM ins ON CONFLICT (content_id) DO NOTHING;
