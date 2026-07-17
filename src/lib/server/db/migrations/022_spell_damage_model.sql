-- VTT Phase 3 (magic) - spell damage/scaling fields. Lives on spell_definitions
-- itself (a spell's own baseline), not as modifier_targets rows - damage is a
-- structured, multi-part property of the spell (dice + type + attack-vs-save +
-- upcast/cantrip scaling), not a single scalar/dice value the modifier_targets
-- registry is designed for. Bonuses/multipliers on top of this baseline (e.g. a
-- homebrew item that doubles a specific spell's dice) still go through the
-- ordinary Modifier system, targeting damage_roll.spell.* - see dnd5e.ts's
-- resolveSpellDamage().
ALTER TABLE spell_definitions
  ADD COLUMN IF NOT EXISTS resolution_type text NOT NULL DEFAULT 'attack'
    CHECK (resolution_type IN ('attack', 'save', 'auto')),
  ADD COLUMN IF NOT EXISTS damage_type text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS base_dice text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS save_ability text NOT NULL DEFAULT 'dex'
    CHECK (save_ability IN ('str', 'dex', 'con', 'int', 'wis', 'cha')),
  ADD COLUMN IF NOT EXISTS save_effect text NOT NULL DEFAULT 'half'
    CHECK (save_effect IN ('half', 'negate')),
  ADD COLUMN IF NOT EXISTS scaling_json jsonb NOT NULL DEFAULT '{}'::jsonb;
