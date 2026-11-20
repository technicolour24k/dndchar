// Shared attack/roll orchestration, extracted verbatim from CharacterSheetForm.svelte so the
// exact same roll (dice-pool advantage/disadvantage, extra dice, crit outcomes, weapon/ability
// bonuses, source-attributed audit text) can run in two places without diverging:
//   1. the character sheet (client-side, via thin wrappers in the component), and
//   2. the VTT's server-side roll endpoint (which the vanilla VTT client can't get to $lib from).
//
// Everything here is pure: no component state, no reactivity. Dependencies (modifierSources,
// ability scores, proficiency bonus, class rows, and the RNG) are passed in. The mechanical
// primitives it builds on already live in ./dnd5e - this module only stitches them into a full
// weapon attack, which was the one piece still trapped inside the Svelte component.

import type { AbilityKey, ActiveCharacterEffect, CharacterClass, InventoryItem } from '$lib/types/character';
import {
  abilityModifier,
  critMaxDiceBonus,
  mergeDiceTerms,
  modifierConditionMatches,
  modifierTargetMatches,
  resolveCritThreshold,
  resolveD20Outcomes,
  resolveDicePool,
  resolveExtraDiceRolls,
  resolvedNumericModifiers,
  rollD20Pool,
  type DicePoolResolution,
  type ExtraDieResult,
  type ModifierContext
} from './dnd5e';

const defaultRollDie = (sides: number) => Math.floor(Math.random() * sides) + 1;

function signed(value: number) {
  return value >= 0 ? `+${value}` : String(value);
}

// ---------------------------------------------------------------------------------------------
// Advantage / disadvantage sources
//
// Every source of advantage or disadvantage counts once, and they all stack: the pool is
// resolveDicePool(applied advantage count, applied disadvantage count). Sources can come from the
// attacker's modifiers, the target's modifiers, token conditions, or the manual situational
// counters. Each one is listed individually so the audit trail can show it, and so a player can
// untick it before rolling.
// ---------------------------------------------------------------------------------------------

export type AdvantageOrigin = 'attacker' | 'target' | 'attacker_condition' | 'target_condition' | 'situational';

export type AdvantageSource = {
  id: string;
  label: string;
  kind: 'advantage' | 'disadvantage';
  origin: AdvantageOrigin;
  applied: boolean;
};

// The result of the d20 pool, kept alongside the roll so logs can show every die and the kept one.
export type AttackPool = {
  size: number;
  net: number;
  direction: 'highest' | 'lowest' | 'flat';
  advantage: number;
  disadvantage: number;
  manualAdvantage: number;
  manualDisadvantage: number;
  rolls: number[];
  kept: number;
};

// The user's per-roll choices. One shape shared by the sheet's roll-options panel and the VTT
// request body, so both sides mean the same thing by it.
export type RollChoices = {
  disabledSourceIds: string[];
  situationalAdvantage: number;
  situationalDisadvantage: number;
  // INTERIM: manual damage-dice delta, a stopgap until modifiers handle extra damage dice. See
  // the vtt-combat-mechanics plan, "Interim mechanism". Not part of the modifier model.
  manualDamageDice: number;
};

export function defaultRollChoices(): RollChoices {
  return { disabledSourceIds: [], situationalAdvantage: 0, situationalDisadvantage: 0, manualDamageDice: 0 };
}

function clampInt(value: number, min: number, max: number) {
  const whole = Math.trunc(Number(value) || 0);
  return Math.max(min, Math.min(max, whole));
}

// Every modifier that matches on both target AND condition is its own source. The id is built
// from the origin, the owning Container, and the modifier's position so it stays the same between
// the preview and the roll (that is how an unticked box maps back to a source).
export function collectAdvantageSources(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  context: ModifierContext,
  origin: AdvantageOrigin
): AdvantageSource[] {
  const sources: AdvantageSource[] = [];
  for (const effect of effects) {
    effect.modifiers.forEach((modifier, index) => {
      if (modifier.modifierType !== 'advantage' && modifier.modifierType !== 'disadvantage') return;
      if (!modifierTargetMatches(modifier.target, candidates)) return;
      if (!modifierConditionMatches(modifier.conditionExpression, context)) return;
      sources.push({
        id: `${origin}|${effect.id}|${modifier.target}|${modifier.modifierType}|${index}`,
        label: modifier.label?.trim() || effect.name,
        kind: modifier.modifierType,
        origin,
        applied: true
      });
    });
  }
  return sources;
}

// INTERIM: the manual situational counters. Under the dice-pool rule "roll an extra die" is just
// "+1 advantage", so each point is one more source, netted like any other. Clamped 0-5 each,
// independently, so both can be non-zero at once.
export function situationalAdvantageSources(advantage: number, disadvantage: number): AdvantageSource[] {
  const make = (kind: 'advantage' | 'disadvantage', count: number) =>
    Array.from({ length: count }, (_, index): AdvantageSource => ({
      id: `situational|${kind}|${index + 1}`,
      label: 'Situational',
      kind,
      origin: 'situational',
      applied: true
    }));
  return [...make('advantage', clampInt(advantage, 0, 5)), ...make('disadvantage', clampInt(disadvantage, 0, 5))];
}

// Non-mutating. Situational sources can't be unticked (reduce the counter instead).
export function applyDisabled(sources: AdvantageSource[], disabledIds: string[]): AdvantageSource[] {
  const disabled = new Set(disabledIds);
  return sources.map((source) => ({ ...source, applied: source.origin === 'situational' || !disabled.has(source.id) }));
}

function countApplied(sources: AdvantageSource[]) {
  return {
    advantage: sources.filter((source) => source.applied && source.kind === 'advantage').length,
    disadvantage: sources.filter((source) => source.applied && source.kind === 'disadvantage').length
  };
}

// Preview only - never rolls. Used by the VTT preview endpoints and the sheet's roll-options panel.
export function previewAdvantage(
  attackerSources: ActiveCharacterEffect[],
  candidates: string[],
  context: ModifierContext,
  extraSources: AdvantageSource[] = [],
  disabled: string[] = []
): { sources: AdvantageSource[]; pool: DicePoolResolution } {
  const sources = applyDisabled(
    [...collectAdvantageSources(attackerSources, candidates, context, 'attacker'), ...extraSources],
    disabled
  );
  const counts = countApplied(sources);
  return { sources, pool: resolveDicePool(counts.advantage, counts.disadvantage) };
}

// Short pool description for logs, e.g. "3d20 adv x2, keeps 17; manual +1 adv". Empty when the
// roll was a plain single die with no manual points (nothing worth saying). The JS twin of this
// lives in vtt/server/handlers/token.js (formatAttackRollText) - keep the wording in step.
export function poolSummary(pool: AttackPool): string {
  const manual = [
    pool.manualAdvantage ? `manual +${pool.manualAdvantage} adv` : '',
    pool.manualDisadvantage ? `manual +${pool.manualDisadvantage} dis` : ''
  ].filter(Boolean);
  if (pool.size <= 1 && manual.length === 0) return '';
  const base = pool.size <= 1
    ? '1d20 flat'
    : `${pool.size}d20 ${pool.net > 0 ? 'adv' : 'dis'} x${Math.abs(pool.net)}, keeps ${pool.kept}`;
  return manual.length ? `${base}; ${manual.join(', ')}` : base;
}

// INTERIM: manual damage-dice control. Changes the PRIMARY damage dice (the die size of the first
// NdM term; every term of that size is merged into one) by `delta`, never below 1 die. Other die
// sizes, flat numbers and modifier extra dice are untouched. Not part of the modifier model - a
// plain per-roll parameter, to be replaced when proper modifiers cover it.
export function adjustPrimaryDamageDice(
  expression: string,
  delta: number
): { expression: string; applied: number; auditLine: string | null } {
  const requested = clampInt(delta, -5, 5);
  if (requested === 0) return { expression, applied: 0, auditLine: null };
  // Show like dice combined ("1d10 + 1d10" reads as "2d10") in the audit line.
  const shown = mergeDiceTerms(expression.trim());

  const parts = expression.split('+').map((part) => part.trim()).filter(Boolean);
  const parsed = parts.map((part) => part.match(/^(\d*)d(\d+)$/i));
  const firstIndex = parsed.findIndex((match) => match !== null);
  if (firstIndex === -1) {
    return { expression, applied: 0, auditLine: 'Manual damage dice ignored: no dice to adjust' };
  }

  const sides = Number(parsed[firstIndex]![2]);
  let total = 0;
  parsed.forEach((match) => {
    if (match && Number(match[2]) === sides) total += Math.max(1, Number(match[1]) || 1);
  });
  const wanted = total + requested;
  const count = Math.max(1, wanted);
  const clamped = wanted < 1;

  // Merged term goes in the first matching term's position; same-size terms elsewhere are dropped.
  const rebuilt = mergeDiceTerms(parts
    .map((part, index) => {
      const match = parsed[index];
      if (!match || Number(match[2]) !== sides) return part;
      return index === firstIndex ? `${count}d${sides}` : '';
    })
    .filter(Boolean)
    .join(' + '));

  const noun = Math.abs(requested) === 1 ? 'die' : 'dice';
  const signedDelta = requested > 0 ? `+${requested}` : String(requested);
  const note = clamped ? 'manual, clamped to 1' : 'manual';
  return {
    expression: rebuilt,
    applied: count - total,
    auditLine: `${signedDelta} damage ${noun} (${note}): ${shown} -> ${rebuilt}`
  };
}

const originSuffix: Record<AdvantageOrigin, string> = {
  attacker: '',
  target: ' (target)',
  attacker_condition: " (attacker's condition)",
  target_condition: " (target's condition)",
  situational: ' (manual)'
};

// "+1 Advantage: Ring (target)" - the same wording the roll's audit text and the pre-roll panels use.
export function advantageSourceLabel(source: AdvantageSource) {
  const sign = source.kind === 'advantage' ? '+1 Advantage' : '+1 Disadvantage';
  return `${sign}: ${source.label}${originSuffix[source.origin]}`;
}

function advantageSourceLine(source: AdvantageSource) {
  return `${source.applied ? '' : 'Not applied: '}${advantageSourceLabel(source)}`;
}

// Generalized d20 roll used by saves, skills, ability checks, initiative, and to-hit alike.
// modifier-primacy.md §3.3 - count advantage/disadvantage sources per bucket (don't just detect
// presence), net them, and roll a 1+|net|-size d20 pool in the net's direction. §2.6 - emit a
// source-attributed audit trail, not just a number.
//
// Two calling conventions, distinguished by options.flatModifiersIncluded:
//   - false (default): `modifier` is a raw base (e.g. a weapon's to-hit bonus with no
//     bonus/penalty modifiers folded in yet) - this function resolves and adds the candidates'
//     'bonus'/'penalty' modifiers itself. Used by rollAttack/rollManualAttack.
//   - true: `modifier` already has those same bonus/penalty modifiers summed into it (e.g. the
//     sheet's savingThrowTotal()/skillCheckTotal()/effective initiative, which go through
//     resolvedAdditiveModifiers()/resolveCharacterStats() before calling this) - so the 'flat'
//     sum here is skipped to avoid double-counting. Advantage/disadvantage and extra_die still
//     resolve either way, since those are per-roll dice, not part of the passed-in stat.
//
// options.context gates conditional modifiers (class:, attack:, within:, ...). extraAdvantageSources
// are the target / token-condition / situational sources built by the caller, and
// disabledSourceIds are the ones the user unticked.
export type RollWithModifiersOptions = {
  flatModifiersIncluded?: boolean;
  context?: ModifierContext;
  extraAdvantageSources?: AdvantageSource[];
  disabledSourceIds?: string[];
};

export function rollWithModifiers(
  modifierSources: ActiveCharacterEffect[],
  modifier: number,
  candidates: string[] = [],
  modifierBreakdown: Array<{ label: string; value: number }> = [],
  rollDie: (sides: number) => number = defaultRollDie,
  options: RollWithModifiersOptions = {}
): { text: string; natural: number; total: number; pool: AttackPool; advantageSources: AdvantageSource[] } {
  const context = options.context ?? {};
  const relevant = modifierSources.flatMap((effect) => effect.modifiers.map((entry) => ({ effect: effect.name, entry })))
    .filter(({ entry }) => modifierTargetMatches(entry.target, candidates) && modifierConditionMatches(entry.conditionExpression, context));

  const advantageSources = applyDisabled(
    [...collectAdvantageSources(modifierSources, candidates, context, 'attacker'), ...(options.extraAdvantageSources ?? [])],
    options.disabledSourceIds ?? []
  );
  const counts = countApplied(advantageSources);
  const poolResolution = resolveDicePool(counts.advantage, counts.disadvantage);
  const { rolls, chosen: d20 } = rollD20Pool(poolResolution.poolSize, poolResolution.direction, rollDie);
  const pool: AttackPool = {
    size: poolResolution.poolSize,
    net: poolResolution.net,
    direction: poolResolution.direction,
    advantage: counts.advantage,
    disadvantage: counts.disadvantage,
    manualAdvantage: advantageSources.filter((source) => source.origin === 'situational' && source.kind === 'advantage').length,
    manualDisadvantage: advantageSources.filter((source) => source.origin === 'situational' && source.kind === 'disadvantage').length,
    rolls,
    kept: d20
  };

  const flat = options.flatModifiersIncluded ? 0 : relevant.reduce((sum, { entry }) => {
    const value = Number(entry.valueExpression) || 0;
    return sum + (entry.modifierType === 'bonus' ? value : entry.modifierType === 'penalty' ? -value : 0);
  }, 0);
  const extraDice = resolveExtraDiceRolls(modifierSources, candidates, context, rollDie);
  const extraTotal = extraDice.reduce((sum, die) => sum + die.value, 0);
  const total = d20 + modifier + flat + extraTotal;

  const extras = extraDice.map((die) => `${die.label} ${die.expression} (${die.rolls.join(', ')})`).join(' + ');
  const breakdownText = modifierBreakdown.length ? ` (${modifierBreakdown.map((entry) => `${entry.label} ${entry.value}`).join(' + ')})` : '';
  const finalLine = `${d20} ${modifier + flat >= 0 ? '+' : '-'} ${Math.abs(modifier + flat)}${breakdownText}${extras ? ` + ${extras}` : ''} = ${total}`;

  let text: string;
  if (advantageSources.length === 0) {
    text = `d20 ${d20}\n${finalLine}`;
  } else {
    // One line per source (applied or not), then the net line, then the final line.
    const sourceLines = [
      ...advantageSources.filter((source) => source.kind === 'advantage'),
      ...advantageSources.filter((source) => source.kind === 'disadvantage')
    ].map(advantageSourceLine);
    const netLabel = pool.net > 0 ? `+${pool.net}` : String(pool.net);
    const netLine = pool.direction === 'flat'
      ? `Net 0 (${pool.advantage} adv, ${pool.disadvantage} dis): flat, rolled 1d20 [${rolls.join(', ')}]`
      : `Net ${netLabel} (${pool.advantage} adv, ${pool.disadvantage} dis): rolled ${pool.size}d20 [${rolls.join(', ')}], kept ${d20} (${pool.direction})`;
    text = [...sourceLines, '', netLine, finalLine].join('\n');
  }

  return { text, natural: d20, total, pool, advantageSources };
}

export function rollDamage(
  expression: string,
  bonus: number,
  abilityBonus = 0,
  abilityLabel = '',
  modifierBonuses: Array<{ label: string; value: number }> = [],
  extraDice: ExtraDieResult[] = [],
  rollDie: (sides: number) => number = defaultRollDie,
  // True when the hit was critical: applies the HOMEBREW crit rule (the primary dice's max added once,
  // see critMaxDiceBonus). Callers pass this from the to-hit outcome; heals and items never do.
  critical = false
): { total: number; lines: string[] } {
  const parts = expression
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean);
  const lines: string[] = [];
  let total = 0;

  for (const part of parts) {
    const dice = part.match(/^(\d*)d(\d+)$/i);
    if (dice) {
      const count = Math.max(1, Number(dice[1]) || 1);
      const sides = Math.max(1, Number(dice[2]) || 1);
      const rolls = Array.from({ length: count }, () => rollDie(sides));
      const subtotal = rolls.reduce((sum, roll) => sum + roll, 0);
      total += subtotal;
      lines.push(`${part}: ${rolls.join(', ')} = ${total}`);
      continue;
    }

    const flat = Number(part);
    if (Number.isFinite(flat)) {
      total += flat;
      lines.push(`${flat >= 0 ? '+' : '-'}${Math.abs(flat)} = ${total}`);
    }
  }

  // modifier-primacy.md §2.1/§6.3 - a Container's own attached 'extra_die' Modifiers (e.g. its
  // base weapon damage die, sourced from the Modifier system rather than the legacy flat
  // expression above) get their own attributed line, same as any other modifier-granted die.
  for (const die of extraDice) {
    total += die.value;
    lines.push(`${die.label}: ${die.expression} (${die.rolls.join(', ')}) = ${total}`);
  }

  if (critical) {
    const crit = critMaxDiceBonus(expression);
    if (crit.auditLine) {
      total += crit.bonus;
      lines.push(`${crit.auditLine} = ${total}`);
    }
  }

  if (bonus) {
    total += bonus;
    lines.push(`Weapon: ${signed(bonus)} = ${total}`);
  }

  if (abilityBonus) {
    total += abilityBonus;
    lines.push(`${abilityLabel} Modifier: ${signed(abilityBonus)} = ${total}`);
  }

  for (const modifierBonus of modifierBonuses) {
    total += modifierBonus.value;
    lines.push(`${modifierBonus.label}: ${signed(modifierBonus.value)} = ${total}`);
  }

  lines.push(`Total: ${total}`);

  return {
    total,
    lines: lines.length ? lines : ['No damage dice', 'Total: 0']
  };
}

export function damageCandidatesFor(item: InventoryItem): string[] {
  const canBeMeleeWeaponAttack = ['weapon', 'shield'].includes(item.category) && item.attackAbility === 'str';
  return [
    'damage_roll.all',
    'damage_roll.weapon',
    item.attackAbility ? `damage_roll.weapon.${item.attackAbility}` : '',
    canBeMeleeWeaponAttack ? 'damage_roll.melee_weapon' : '',
    canBeMeleeWeaponAttack ? `damage_roll.melee_weapon.${item.attackAbility}` : ''
  ].filter(Boolean);
}

export function battleDamageBonuses(
  modifierSources: ActiveCharacterEffect[],
  item: InventoryItem,
  classes: CharacterClass[],
  outcomes: string[] = []
): Array<{ label: string; value: number }> {
  const candidates = damageCandidatesFor(item);
  const context = {
    classes,
    attackType: 'melee_weapon',
    ability: item.attackAbility,
    outcomes
  } as const;
  return [
    ...resolvedNumericModifiers(modifierSources, candidates, ['bonus'], context),
    ...resolvedNumericModifiers(modifierSources, candidates, ['penalty'], context).map((penalty) => ({ ...penalty, value: -penalty.value }))
  ];
}

// Attacker-side attack_roll candidates for a weapon attack. Shared by rollAttack, the VTT preview
// and the sheet's roll-options panel so the three can't drift apart.
export function attackCandidatesFor(item: InventoryItem): string[] {
  return ['attack_roll.weapon', `attack_roll.weapon.${item.attackAbility}`,
    item.category === 'weapon' ? 'attack_roll.melee_weapon' : '',
    item.category === 'weapon' ? `attack_roll.melee_weapon.${item.attackAbility}` : ''].filter(Boolean);
}

// Target-side candidates: modifiers on the creature being attacked ("attacks against me").
// Deliberately no ranged_weapon key yet (rollAttack is melee-only for now).
export function attackAgainstCandidatesFor(item: InventoryItem): string[] {
  return ['attacks_against.weapon', item.category === 'weapon' ? 'attacks_against.melee_weapon' : ''].filter(Boolean);
}

export const spellAttackAgainstCandidates = ['attacks_against.spell'];

// Attacker-side candidates for a spell attack roll. Shared by the VTT roll-spell endpoint and the
// sheet's spell attack (and its roll-options panel), so the two can't drift.
export const spellAttackCandidates = ['spell_attack_roll', 'attack_roll.spell'];

export interface AttackRollContext {
  modifierSources: ActiveCharacterEffect[];
  abilityScores: Record<AbilityKey, number>;
  proficiencyBonus: number;
  classes: CharacterClass[];
  rollDie?: (sides: number) => number;
  // Advantage inputs. extraAdvantageSources are the target / token-condition / situational sources
  // built by the caller; disabledSourceIds are the ones the user unticked.
  distanceFt?: number;
  extraAdvantageSources?: AdvantageSource[];
  disabledSourceIds?: string[];
  // INTERIM: manual damage-dice delta (see adjustPrimaryDamageDice).
  manualDamageDice?: number;
}

export interface AttackRollResult {
  title: string;
  attack: string;
  damage: string[];
  effects: string;
  // Extra structured fields (beyond what the sheet modal renders) so the VTT can decide
  // hit/miss against a target's AC and apply damage without re-parsing the display text.
  attackTotal: number;
  attackNatural: number;
  damageTotal: number;
  outcomes: string[];
  // The d20 pool (every die rolled and the kept one), the listed sources, and the manual
  // damage-dice delta that was actually applied (after clamping).
  attackPool: AttackPool;
  advantageSources: AdvantageSource[];
  manualDamageDice: number;
}

// The full two-phase weapon attack (modifier-primacy.md §6.4): resolve the to-hit roll first,
// turn its natural die into the named outcomes it satisfied (crit etc.), then resolve damage with
// those outcomes in context so outcome-gated damage Modifiers (a crit-only bonus die) apply.
export function rollAttack(item: InventoryItem, ctx: AttackRollContext): AttackRollResult {
  const { modifierSources, abilityScores, proficiencyBonus: prof, classes } = ctx;
  const rollDie = ctx.rollDie ?? defaultRollDie;

  const ability = abilityModifier(abilityScores[item.attackAbility]);
  const attackBreakdown = [
    ...(item.proficient ? [{ label: 'Proficiency', value: prof }] : []),
    { label: `${item.attackAbility.toUpperCase()} Mod`, value: ability },
    ...(Number(item.toHitBonus) ? [{ label: 'Weapon', value: Number(item.toHitBonus) }] : [])
  ];
  const attackBonus = attackBreakdown.reduce((sum, entry) => sum + entry.value, 0);
  const attackCandidates = attackCandidatesFor(item);

  // Phase 1 - resolve the triggering (to-hit) roll first.
  const rollContext = { classes, ability: item.attackAbility, attackType: 'melee_weapon', distanceFt: ctx.distanceFt } as const;
  const attackRoll = rollWithModifiers(modifierSources, attackBonus, attackCandidates, attackBreakdown, rollDie, {
    context: rollContext,
    extraAdvantageSources: ctx.extraAdvantageSources,
    disabledSourceIds: ctx.disabledSourceIds
  });

  // Phase 1 -> 2 handoff: turn the to-hit result into the named outcomes it satisfied, before
  // deciding which damage Modifiers (e.g. a crit-only bonus) are active for this roll.
  const critThreshold = resolveCritThreshold(modifierSources, { ability: item.attackAbility, attackType: 'melee_weapon' });
  const outcomes = resolveD20Outcomes(attackRoll.natural, critThreshold);

  // Phase 2 - resolve the dependent (damage) roll using the now-known outcome set.
  const damageCandidates = damageCandidatesFor(item);
  const damageContext = { classes, attackType: 'melee_weapon', ability: item.attackAbility, outcomes } as const;
  const extraDice = resolveExtraDiceRolls(modifierSources, damageCandidates, damageContext, rollDie);
  // INTERIM: manual damage-dice delta, applied to the primary dice before rolling.
  const adjusted = adjustPrimaryDamageDice(item.damageRolls, ctx.manualDamageDice ?? 0);
  const damage = rollDamage(
    adjusted.expression,
    Number(item.damageBonus || 0),
    ability,
    item.attackAbility.toUpperCase(),
    battleDamageBonuses(modifierSources, item, classes, outcomes),
    extraDice,
    rollDie,
    outcomes.includes('critical_hit')
  );

  return {
    title: item.name || 'Battle Action',
    attack: `${attackRoll.text} (beats AC ${attackRoll.total} or below)${outcomes.length ? ` - ${outcomes.join(', ')}` : ''}`,
    damage: adjusted.auditLine ? [adjusted.auditLine, ...damage.lines] : damage.lines,
    effects: item.effects || item.notes || '-',
    attackTotal: attackRoll.total,
    attackNatural: attackRoll.natural,
    damageTotal: damage.total,
    outcomes,
    attackPool: attackRoll.pool,
    advantageSources: attackRoll.advantageSources,
    manualDamageDice: adjusted.applied
  };
}

export interface ManualAttack {
  name: string;
  toHitBonus: number;
  damageRolls: string;
  damageBonus: number;
}

// A DM's monster/stat-block attack: no character, no modifier graph - the
// to-hit bonus and damage are entered directly, so this rolls a plain
// `d20 + toHitBonus` and `damageRolls + damageBonus` through the same helpers
// (and returns the same shape) as a full character attack, so the VTT's attack
// flow and result display are identical whether the source is a PC or a monster.
export function rollManualAttack(
  attack: ManualAttack,
  rollDie: (sides: number) => number = defaultRollDie,
  // allowCrit: false for a save/auto spell, whose (discarded) d20 must not make the damage critical.
  options: { extraAdvantageSources?: AdvantageSource[]; disabledSourceIds?: string[]; manualDamageDice?: number; allowCrit?: boolean } = {}
): AttackRollResult {
  const toHitBonus = Number(attack.toHitBonus) || 0;
  // A monster has no sheet modifiers of its own, so only target / token-condition / situational
  // sources (passed in by the caller) can apply.
  const attackRoll = rollWithModifiers([], toHitBonus, [], [{ label: 'To hit', value: toHitBonus }], rollDie, {
    extraAdvantageSources: options.extraAdvantageSources,
    disabledSourceIds: options.disabledSourceIds
  });
  const outcomes = resolveD20Outcomes(attackRoll.natural, 20);
  // INTERIM: manual damage-dice delta.
  const adjusted = adjustPrimaryDamageDice(String(attack.damageRolls || ''), options.manualDamageDice ?? 0);
  const damage = rollDamage(adjusted.expression, Number(attack.damageBonus) || 0, 0, '', [], [], rollDie,
    (options.allowCrit ?? true) && outcomes.includes('critical_hit'));
  return {
    title: attack.name || 'Attack',
    attack: `${attackRoll.text} (beats AC ${attackRoll.total} or below)${outcomes.length ? ` - ${outcomes.join(', ')}` : ''}`,
    damage: adjusted.auditLine ? [adjusted.auditLine, ...damage.lines] : damage.lines,
    effects: '-',
    attackTotal: attackRoll.total,
    attackNatural: attackRoll.natural,
    damageTotal: damage.total,
    outcomes,
    attackPool: attackRoll.pool,
    advantageSources: attackRoll.advantageSources,
    manualDamageDice: adjusted.applied
  };
}
