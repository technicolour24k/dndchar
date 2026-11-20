DO $$
BEGIN
  IF to_regclass('public.effect_modifiers') IS NOT NULL
    AND to_regclass('public.legacy_effect_modifiers') IS NULL THEN
    ALTER TABLE effect_modifiers RENAME TO legacy_effect_modifiers;
  END IF;
END $$;

DO $$
BEGIN
  IF to_regclass('public.effect_modifiers_effect_id_idx') IS NOT NULL
    AND to_regclass('public.legacy_effect_modifiers_effect_id_idx') IS NULL THEN
    ALTER INDEX effect_modifiers_effect_id_idx RENAME TO legacy_effect_modifiers_effect_id_idx;
  END IF;
END $$;
