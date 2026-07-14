-- VTT Phase 2 (Section 1) - registers vision.*_ft as real modifier targets so
-- a DM authoring a Darkvision/truesight/etc container via /admin/rules gets
-- proper labels immediately, rather than the target defaulting to
-- runtime_supported=false (misleading, since dnd5e.ts's visionRadii() does
-- resolve these live). Per docs/architecture/modifier-primacy-architecture.md,
-- these are ordinary Modifiers like AC/speed - not feats, not race traits -
-- so no other schema change is needed to support them.
INSERT INTO modifier_targets (target_key, label, category, value_kind, runtime_supported) VALUES
  ('vision.normal_ft', 'Normal Vision Range (ft)', 'senses', 'number', true),
  ('vision.dark_ft', 'Darkvision Range (ft)', 'senses', 'number', true),
  ('vision.true_ft', 'Truesight Range (ft)', 'senses', 'number', true),
  ('vision.devil_ft', 'Devil''s Sight Range (ft)', 'senses', 'number', true)
ON CONFLICT (target_key) DO UPDATE SET
  label = EXCLUDED.label,
  category = EXCLUDED.category,
  value_kind = EXCLUDED.value_kind,
  runtime_supported = EXCLUDED.runtime_supported;
