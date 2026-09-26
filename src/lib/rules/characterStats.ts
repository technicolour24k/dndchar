// Overridable sheet stats (docs/architecture/modifier-primacy-status.md, "Deliberate
// deviations (accepted)" section - this file is the counterpart in code).
//
// This is the one place manual stat overrides are resolved. Every one of the 9 overridable
// combat-summary/magic stats (proficiency, AC, initiative, speed, the three passives, spell
// save DC, spell attack bonus) goes through resolveStat() below, so the precedence rule below
// is enforced in exactly one place rather than re-implemented per stat.
//
// Precedence rule (confirmed by the user, see the overridable-sheet-stats plan): the manual
// *adjustment* is summed INTO the computed pipeline, BEFORE any 'set'-type modifier - a 'set'
// modifier replaces the adjusted base, discarding the adjustment. The manual *override* is
// final and beats everything, sets included; when an override is set the stored adjustment is
// kept (so it's still there if the override is cleared) but not applied.
//
// Why overrides live in character metadata rather than as Modifier grants: a manual override
// isn't a reusable mechanic - it isn't a definition, isn't shared, and isn't granted by
// anything. It's a number the player typed, in the same class as current HP. Attaching a grant
// to a Container is DM/admin-gated (modifier-primacy.md §6.1), which would stop a player
// setting their own AC override; proficiency_bonus isn't a modifier target at all; and the
// engine has no 'set' tie-break rule today, whereas the user has already settled one for manual
// overrides specifically. See modifier-primacy-status.md for the full writeup.
//
// Must stay importable from both client and server code: no $lib/server imports here.

import {
  abilityKeys,
  abilityMap,
  abilityModifier,
  armorClass,
  equippedItems,
  initiativeBonus,
  passiveScore,
  proficiencyBonus,
  resolvedAdditiveModifiers,
  speedPipeline,
  spellAttackBonus,
  spellSaveDc,
  totalLevel
} from './dnd5e';
import type { AbilityKey, ActiveCharacterEffect, CharacterClass, CharacterDetail, InventoryItem } from '$lib/types/character';

export const OVERRIDABLE_STATS = [
  'proficiency',
  'armorClass',
  'initiative',
  'speed',
  'passivePerception',
  'passiveInsight',
  'passiveInvestigation',
  'spellSaveDc',
  'spellAttackBonus'
] as const;

export type OverridableStat = (typeof OVERRIDABLE_STATS)[number];

export type StatOverride = { adjustment: number; override: number | null };

export type StatOverrides = Partial<Record<OverridableStat, StatOverride>>;

const OVERRIDABLE_STAT_SET = new Set<string>(OVERRIDABLE_STATS);

function coerceFiniteInt(value: unknown, fallback: number): number {
  const numeric = Math.trunc(Number(value));
  return Number.isFinite(numeric) ? numeric : fallback;
}

// Reads metadata.statOverrides - tolerant of missing/malformed input (never throws), since
// metadata_json is untyped JSONB and may contain anything (or nothing, for pre-feature
// characters/snapshots). Unknown keys and non-object entries are ignored. Default entries
// (adjustment 0, override null) are dropped, matching the "only non-default entries are
// stored" rule so a reset genuinely clears the key rather than leaving a no-op entry behind.
export function readStatOverrides(metadata: Record<string, unknown> | null | undefined): StatOverrides {
  const raw = metadata && typeof metadata === 'object' ? (metadata as Record<string, unknown>).statOverrides : undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};

  const result: StatOverrides = {};
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!OVERRIDABLE_STAT_SET.has(key)) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const source = entry as Record<string, unknown>;
    const adjustment = coerceFiniteInt(source.adjustment, 0);
    const overrideRaw = source.override;
    const override = overrideRaw === null || overrideRaw === undefined ? null : coerceFiniteInt(overrideRaw, NaN);
    const resolvedOverride = Number.isFinite(override as number) ? (override as number) : null;
    if (adjustment === 0 && resolvedOverride === null) continue;
    result[key as OverridableStat] = { adjustment, override: resolvedOverride };
  }
  return result;
}

export type ResolvedStat = {
  computed: number; // pipeline result with NO manual input
  adjusted: number; // pipeline result WITH the adjustment folded in
  adjustment: number;
  adjustmentReplacedBy: string | null; // label of the set modifier that discarded the adjustment, if any
  override: number | null;
  value: number; // override ?? adjusted
  isAdjusted: boolean;
  isOverridden: boolean;
};

// Resolves one stat through the precedence rule above. `pipeline` computes the stat's value
// given a manual adjustment folded in at the correct point (for most stats that's just
// `base + adjustment`; for speed it's the full set/bonus/multiplier pipeline run with the
// adjustment inside it - see speedPipeline in dnd5e.ts). Calling `pipeline(0)` always gives the
// fully-computed value with no manual input at all, which is what "Calculated" / "computed"
// means throughout the UI.
export function resolveStat(
  entry: StatOverride | undefined,
  pipeline: (adjustment: number) => { value: number; adjustmentReplacedBy?: string | null },
  opts: { min?: number } = {}
): ResolvedStat {
  const adjustment = entry?.adjustment ?? 0;
  const rawOverride = entry?.override ?? null;

  const computedResult = pipeline(0);
  const adjustedResult = pipeline(adjustment);

  const computed = computedResult.value;
  const adjusted = opts.min !== undefined ? Math.max(opts.min, adjustedResult.value) : adjustedResult.value;
  // Clamp the override here too, not just wherever a caller happens to write one - opts.min is
  // an invariant of the stat itself (e.g. speed can never be negative), so it must hold no
  // matter which caller produced the stored value. The clamped figure is what's returned/shown,
  // not the raw stored one, so `value`/`override` and the "Manual override: N" breakdown line
  // never disagree.
  const override = rawOverride !== null && opts.min !== undefined ? Math.max(opts.min, rawOverride) : rawOverride;
  const value = override ?? adjusted;

  return {
    computed,
    adjusted,
    adjustment,
    adjustmentReplacedBy: adjustedResult.adjustmentReplacedBy ?? null,
    override,
    value,
    isAdjusted: adjustment !== 0,
    isOverridden: override !== null
  };
}

// Parses whatever a player typed into an overridable field or the Manual override box.
// Trims first, so "" and "  " both count as blank (clear the override, keep the adjustment).
// Otherwise takes the leading signed integer - "+3", "3", "-1", "30 ft.", "30ft", " 30 " all
// parse; anything with no leading integer ("fast") is invalid. "2.6" truncates to 2 via the
// regex matching only the integer part.
export function parseStatInput(raw: string): number | 'blank' | 'invalid' {
  const trimmed = raw.trim();
  if (!trimmed) return 'blank';
  const match = trimmed.match(/^([+-]?\d+)/);
  if (!match) return 'invalid';
  return Number(match[1]);
}

// Builds the "Manual" section of a formula-help breakdown for one stat. Returns [] when
// neither an adjustment nor an override is set, so withManualLines() below can leave
// untouched stats' breakdowns exactly as they were before this feature.
export function manualOverrideLines(stat: ResolvedStat, fmt: (n: number) => string): string[] {
  if (!stat.isAdjusted && !stat.isOverridden) return [];

  const lines: string[] = [`Calculated: ${fmt(stat.computed)}`];

  if (stat.isAdjusted) {
    const suffix = stat.adjustmentReplacedBy
      ? ` (replaced by ${stat.adjustmentReplacedBy})`
      : stat.isOverridden
        ? ' (not applied - overridden)'
        : '';
    lines.push(`Manual adjustment: ${signedInt(stat.adjustment)}${suffix}`);
    if (!stat.adjustmentReplacedBy && !stat.isOverridden) {
      lines.push(`Adjusted: ${fmt(stat.adjusted)}`);
    }
  }

  if (stat.isOverridden) {
    lines.push(`Manual override: ${fmt(stat.override as number)} (computed: ${fmt(stat.adjusted)})`);
  }

  lines.push(`Total: ${fmt(stat.value)}`);
  return lines;
}

function signedInt(value: number): string {
  return value >= 0 ? `+${value}` : String(value);
}

// Merges manualOverrideLines() into an existing formula breakdown. When there's no manual
// state at all, baseLines is returned unchanged - so every existing caller (saves, skills, hit
// dice) that never has manual state keeps working exactly as before. Otherwise the trailing
// `Total: ...` line (computed with no manual input) is dropped and replaced by the manual
// section, which ends with its own Total reflecting the resolved value.
export function withManualLines(baseLines: string[], stat: ResolvedStat, fmt: (n: number) => string): string[] {
  const manualLines = manualOverrideLines(stat, fmt);
  if (!manualLines.length) return baseLines;

  const withoutTrailingTotal = baseLines.length && baseLines[baseLines.length - 1].startsWith('Total:')
    ? baseLines.slice(0, -1)
    : baseLines;

  return [...withoutTrailingTotal, ...manualLines];
}

// Matches the sheet's existing fallback chain (CharacterSheetForm.svelte's `spellcastingAbility`
// derived): a class's own spellcastingAbility wins first, then metadata.spellcastingAbility
// (lower-cased, and only if it's a real ability key), then 'int'. Fixes a pre-existing drift
// where the VTT's roll-spell endpoint ignored the metadata fallback entirely and just used 'int'.
export function resolveSpellcastingAbility(classes: CharacterClass[], metadata: Record<string, unknown>): AbilityKey {
  const fromClass = classes[0]?.spellcastingAbility;
  if (fromClass) return fromClass;
  const fromMetadata = String(metadata?.spellcastingAbility ?? '').toLowerCase();
  if (abilityKeys.includes(fromMetadata as AbilityKey)) return fromMetadata as AbilityKey;
  return 'int';
}

export type CharacterStatInputs = {
  classes: CharacterClass[];
  abilityScores: Record<AbilityKey, number>;
  modifierSources: ActiveCharacterEffect[];
  inventory: InventoryItem[];
  savingThrowProficiencies: AbilityKey[];
  skillProficiencies: string[];
  spellcastingAbility: AbilityKey;
  overrides: StatOverrides;
};

export type CharacterStats = {
  level: number;
  proficiency: ResolvedStat;
  armorClass: ResolvedStat;
  initiative: ResolvedStat;
  speed: ResolvedStat;
  passivePerception: ResolvedStat;
  passiveInsight: ResolvedStat;
  passiveInvestigation: ResolvedStat;
  spellSaveDc: ResolvedStat;
  spellAttackBonus: ResolvedStat;
  savingThrows: Record<AbilityKey, number>; // ability mod + effective prof if proficient + saving_throw.<key> additive modifiers
};

// The single reusable resolver for every overridable stat on the sheet - order and content
// must match what the sheet computed inline before this feature (CharacterSheetForm.svelte's
// combatFormulaHelp/computed* deriveds). Every stat goes through resolveStat(), and proficiency
// is resolved FIRST so its effective (overridden/adjusted) value cascades into every stat that
// depends on it, exactly like a hand-typed proficiency bonus would.
export function resolveCharacterStats(input: CharacterStatInputs): CharacterStats {
  const { classes, abilityScores, modifierSources, inventory, savingThrowProficiencies, skillProficiencies, spellcastingAbility, overrides } = input;
  const level = totalLevel(classes);
  const context = { classes };

  // 1. Proficiency - every other stat below reads effectiveProf, not proficiencyBonus(level)
  // directly, so a proficiency override/adjustment cascades everywhere the printed sheet uses
  // proficiency (saves, skills, passives, spell DC/attack, weapon to-hit).
  const proficiency = resolveStat(overrides.proficiency, (a) => ({ value: proficiencyBonus(level) + a }));
  const effectiveProf = proficiency.value;

  // 2. Armor Class. No 'set' support in armorClass() today - the adjustment is a plain extra
  // term, per the comment on speedPipeline() above; if 'set' is ever added here the same
  // "set replaces base + adjustment" rule from speed applies.
  const equippedAcBonus = equippedItems(inventory).reduce((sum, item) => sum + (Number(item.acBonus) || 0), 0);
  const armorClassStat = resolveStat(overrides.armorClass, (a) => ({ value: armorClass(abilityScores.dex, equippedAcBonus, modifierSources, context) + a }));

  // 3. Initiative - same "no set support" note as AC.
  const initiative = resolveStat(overrides.initiative, (a) => ({ value: initiativeBonus(abilityScores.dex, modifierSources, context) + a }));

  // 4. Speed - the one stat whose resolver honours 'set' (Grappled etc.), so the adjustment is
  // folded INTO speedPipeline's base rather than added after, per the module header comment.
  const speed = resolveStat(overrides.speed, (a) => speedPipeline(modifierSources, context, a), { min: 0 });

  // 5. Passives - same candidate lists as the sheet (CharacterSheetForm.svelte lines 240-251).
  // No 'set' support, same as AC/initiative.
  const passivePerception = resolveStat(overrides.passivePerception, (a) =>
    ({ value: passiveScore(abilityScores.wis, skillProficiencies.includes('perception'), effectiveProf, modifierSources, ['ability_check.perception', 'passive.perception'], context) + a }));
  const passiveInsight = resolveStat(overrides.passiveInsight, (a) =>
    ({ value: passiveScore(abilityScores.wis, skillProficiencies.includes('insight'), effectiveProf, modifierSources, ['ability_check.insight', 'passive.insight'], context) + a }));
  const passiveInvestigation = resolveStat(overrides.passiveInvestigation, (a) =>
    ({ value: passiveScore(abilityScores.int, skillProficiencies.includes('investigation'), effectiveProf, modifierSources, ['ability_check.investigation', 'passive.investigation'], context) + a }));

  // 6. Spell DC / Spell Attack - via the explicit-prof 4th param added to dnd5e.ts, so these
  // use effectiveProf rather than recomputing proficiencyBonus(level). No 'set' support.
  const spellDcBonuses = resolvedAdditiveModifiers(modifierSources, ['spell_save_dc'], context).map((bonus) => bonus.value);
  const spellSaveDcStat = resolveStat(overrides.spellSaveDc, (a) => ({ value: spellSaveDc(abilityScores[spellcastingAbility] ?? 10, level, spellDcBonuses, effectiveProf) + a }));
  const spellAttackBonuses = resolvedAdditiveModifiers(modifierSources, ['spell_attack_roll', 'attack_roll.spell'], context).map((bonus) => bonus.value);
  const spellAttackBonusStat = resolveStat(overrides.spellAttackBonus, (a) => ({ value: spellAttackBonus(abilityScores[spellcastingAbility] ?? 10, level, spellAttackBonuses, effectiveProf) + a }));

  // 7. Saving throws - not individually overridable (out of scope, see the plan's Follow-ups),
  // but they still cascade from the effective proficiency bonus above.
  const savingThrows = Object.fromEntries(abilityKeys.map((key) => {
    const bonuses = resolvedAdditiveModifiers(modifierSources, [`saving_throw.${key}`], context).reduce((sum, bonus) => sum + bonus.value, 0);
    const proficient = savingThrowProficiencies.includes(key);
    return [key, abilityModifier(abilityScores[key]) + (proficient ? effectiveProf : 0) + bonuses];
  })) as Record<AbilityKey, number>;

  return {
    level,
    proficiency,
    armorClass: armorClassStat,
    initiative,
    speed,
    passivePerception,
    passiveInsight,
    passiveInvestigation,
    spellSaveDc: spellSaveDcStat,
    spellAttackBonus: spellAttackBonusStat,
    savingThrows
  };
}

// Convenience wrapper for server routes that already have a full CharacterDetail (VTT API/roll
// endpoints) - builds the CharacterStatInputs from it so callers don't have to repeat the
// abilityMap/readStatOverrides/resolveSpellcastingAbility boilerplate at every call site.
export function characterStatsFor(character: CharacterDetail): CharacterStats {
  return resolveCharacterStats({
    classes: character.classes,
    abilityScores: abilityMap(character.abilities),
    modifierSources: character.modifierSources,
    inventory: character.inventory,
    savingThrowProficiencies: character.proficiencies.savingThrows,
    skillProficiencies: character.proficiencies.skills,
    spellcastingAbility: resolveSpellcastingAbility(character.classes, character.metadata),
    overrides: readStatOverrides(character.metadata)
  });
}

// For catalogue.ts, which resolves resource maxima (e.g. "proficiency_bonus" resource
// expressions) without loading a full CharacterDetail.
export function effectiveProficiencyBonus(level: number, overrides: StatOverrides): number {
  return resolveStat(overrides.proficiency, (a) => ({ value: proficiencyBonus(level) + a })).value;
}
