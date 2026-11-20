-- Fills the blank descriptions on the four vision targets so /admin/rules tells a DM which op to
-- use. Darkvision-style grants should use the "At least" (minimum) op, which is highest-wins and
-- never sums. Additive and idempotent: only touches rows whose description is still empty.
UPDATE modifier_targets
SET description = 'Use ''At least'' for darkvision-style grants (highest wins). Bonus adds range on top.'
WHERE target_key IN ('vision.normal_ft', 'vision.dark_ft', 'vision.true_ft', 'vision.devil_ft')
  AND description = '';
