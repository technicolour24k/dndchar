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
  modifierTargetMatches,
  resolveCritThreshold,
  resolveD20Outcomes,
  resolveDicePool,
  resolveExtraDiceRolls,
  resolvedNumericModifiers,
  rollD20Pool,
  type ExtraDieResult
} from './dnd5e';

const defaultRollDie = (sides: number) => Math.floor(Math.random() * sides) + 1;

function signed(value: number) {
  return value >= 0 ? `+${value}` : String(value);
}

// Generalized d20 roll used by saves, skills, ability checks, initiative, and to-hit alike.
// modifier-primacy.md §3.3 - count advantage/disadvantage sources per bucket (don't just detect
// presence), net them, and roll a 1+|net|-size d20 pool in the net's direction. §2.6 - emit a
// source-attributed audit trail, not just a number.
export function rollWithModifiers(
  modifierSources: ActiveCharacterEffect[],
  modifier: number,
  candidates: string[] = [],
  modifierBreakdown: Array<{ label: string; value: number }> = [],
  rollDie: (sides: number) => number = defaultRollDie
): { text: string; natural: number; total: number } {
  const relevant = modifierSources.flatMap((effect) => effect.modifiers.map((entry) => ({ effect: effect.name, entry })))
    .filter(({ entry }) => modifierTargetMatches(entry.target, candidates));

  const advantageSources = relevant.filter(({ entry }) => entry.modifierType === 'advantage').map(({ effect }) => effect);
  const disadvantageSources = relevant.filter(({ entry }) => entry.modifierType === 'disadvantage').map(({ effect }) => effect);
  const pool = resolveDicePool(advantageSources.length, disadvantageSources.length);
  const { rolls, chosen: d20 } = rollD20Pool(pool.poolSize, pool.direction, rollDie);

  const flat = relevant.reduce((sum, { entry }) => {
    const value = Number(entry.valueExpression) || 0;
    return sum + (entry.modifierType === 'bonus' ? value : entry.modifierType === 'penalty' ? -value : 0);
  }, 0);
  const extraDice = resolveExtraDiceRolls(modifierSources, candidates, {}, rollDie);
  const extraTotal = extraDice.reduce((sum, die) => sum + die.value, 0);
  const total = d20 + modifier + flat + extraTotal;

  const extras = extraDice.map((die) => `${die.label} ${die.expression} (${die.rolls.join(', ')})`).join(' + ');
  const breakdownText = modifierBreakdown.length ? ` (${modifierBreakdown.map((entry) => `${entry.label} ${entry.value}`).join(' + ')})` : '';
  const finalLine = `${d20} ${modifier + flat >= 0 ? '+' : '-'} ${Math.abs(modifier + flat)}${breakdownText}${extras ? ` + ${extras}` : ''} = ${total}`;

  let text: string;
  if (pool.advantageCount === 0 && pool.disadvantageCount === 0) {
    text = `d20 ${d20}\n${finalLine}`;
  } else {
    const directionLabel = pool.direction === 'highest' ? 'Advantage' : pool.direction === 'lowest' ? 'Disadvantage' : 'Normal';
    const sourceLines = [
      ...disadvantageSources.map((name) => `Disadvantage (${name})`),
      ...advantageSources.map((name) => `Advantage (${name})`)
    ];
    const rollLine = `Roll 1+${Math.abs(pool.net)} (${pool.advantageCount} Advantage - ${pool.disadvantageCount} Disadvantage) dice = ${pool.poolSize} dice at ${directionLabel}`;
    const rolledLine = `Rolled: ${rolls.join(', ')} - ${d20} wins`;
    text = [...sourceLines, '', rollLine, rolledLine, finalLine].join('\n');
  }

  return { text, natural: d20, total };
}

export function rollDamage(
  expression: string,
  bonus: number,
  abilityBonus = 0,
  abilityLabel = '',
  modifierBonuses: Array<{ label: string; value: number }> = [],
  extraDice: ExtraDieResult[] = [],
  rollDie: (sides: number) => number = defaultRollDie
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

export interface AttackRollContext {
  modifierSources: ActiveCharacterEffect[];
  abilityScores: Record<AbilityKey, number>;
  proficiencyBonus: number;
  classes: CharacterClass[];
  rollDie?: (sides: number) => number;
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
  const attackCandidates = ['attack_roll.weapon', `attack_roll.weapon.${item.attackAbility}`,
    item.category === 'weapon' ? 'attack_roll.melee_weapon' : '',
    item.category === 'weapon' ? `attack_roll.melee_weapon.${item.attackAbility}` : ''].filter(Boolean);

  // Phase 1 - resolve the triggering (to-hit) roll first.
  const attackRoll = rollWithModifiers(modifierSources, attackBonus, attackCandidates, attackBreakdown, rollDie);

  // Phase 1 -> 2 handoff: turn the to-hit result into the named outcomes it satisfied, before
  // deciding which damage Modifiers (e.g. a crit-only bonus) are active for this roll.
  const critThreshold = resolveCritThreshold(modifierSources, { ability: item.attackAbility, attackType: 'melee_weapon' });
  const outcomes = resolveD20Outcomes(attackRoll.natural, critThreshold);

  // Phase 2 - resolve the dependent (damage) roll using the now-known outcome set.
  const damageCandidates = damageCandidatesFor(item);
  const damageContext = { classes, attackType: 'melee_weapon', ability: item.attackAbility, outcomes } as const;
  const extraDice = resolveExtraDiceRolls(modifierSources, damageCandidates, damageContext, rollDie);
  const damage = rollDamage(
    item.damageRolls,
    Number(item.damageBonus || 0),
    ability,
    item.attackAbility.toUpperCase(),
    battleDamageBonuses(modifierSources, item, classes, outcomes),
    extraDice,
    rollDie
  );

  return {
    title: item.name || 'Battle Action',
    attack: `${attackRoll.text} (beats AC ${attackRoll.total} or below)${outcomes.length ? ` - ${outcomes.join(', ')}` : ''}`,
    damage: damage.lines,
    effects: item.effects || item.notes || '-',
    attackTotal: attackRoll.total,
    attackNatural: attackRoll.natural,
    damageTotal: damage.total,
    outcomes
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
export function rollManualAttack(attack: ManualAttack, rollDie: (sides: number) => number = defaultRollDie): AttackRollResult {
  const toHitBonus = Number(attack.toHitBonus) || 0;
  const attackRoll = rollWithModifiers([], toHitBonus, [], [{ label: 'To hit', value: toHitBonus }], rollDie);
  const outcomes = resolveD20Outcomes(attackRoll.natural, 20);
  const damage = rollDamage(String(attack.damageRolls || ''), Number(attack.damageBonus) || 0, 0, '', [], [], rollDie);
  return {
    title: attack.name || 'Attack',
    attack: `${attackRoll.text} (beats AC ${attackRoll.total} or below)${outcomes.length ? ` - ${outcomes.join(', ')}` : ''}`,
    damage: damage.lines,
    effects: '-',
    attackTotal: attackRoll.total,
    attackNatural: attackRoll.natural,
    damageTotal: damage.total,
    outcomes
  };
}
