-- Decks unit 3 (plans/dndchar/decks). Additive and idempotent.
-- 'next_attack' is a new expiry boundary: the effect is removed after the character's next attack
-- roll that counted one of its modifiers (e.g. "advantage on your next attack"). It still counts down
-- like 'round_end', so it is capped by its duration_rounds if no attack is ever made.
-- The CHECK constraints were declared inline (014 on active_character_effects, 019 on
-- content_definitions), so their names are looked up, dropped and re-added under stable names.
-- To roll back: delete or change any 'next_attack' rows, then re-add the old four-value CHECKs.

DO $$
DECLARE
  target record;
  con record;
BEGIN
  FOR target IN SELECT * FROM (VALUES
    ('active_character_effects', 'active_character_effects_expiry_boundary_check'),
    ('content_definitions', 'content_definitions_expiry_boundary_check')
  ) AS t(table_name, constraint_name) LOOP
    FOR con IN
      SELECT c.conname FROM pg_constraint c
      WHERE c.conrelid = target.table_name::regclass AND c.contype = 'c'
        AND pg_get_constraintdef(c.oid) LIKE '%expiry_boundary%'
        AND pg_get_constraintdef(c.oid) LIKE '%round_end%'
    LOOP
      EXECUTE format('ALTER TABLE %I DROP CONSTRAINT %I', target.table_name, con.conname);
    END LOOP;
    EXECUTE format(
      'ALTER TABLE %I ADD CONSTRAINT %I CHECK (expiry_boundary IN (''turn_start'', ''turn_end'', ''round_end'', ''manual'', ''next_attack''))',
      target.table_name, target.constraint_name);
  END LOOP;
END $$;
