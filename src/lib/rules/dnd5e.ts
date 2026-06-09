import type { AbilityKey, ActiveCharacterEffect, CharacterAbility, CharacterClass } from '$lib/types/character';

export const abilityKeys: AbilityKey[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

export function abilityModifier(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function totalLevel(classes: CharacterClass[]): number {
  const total = classes.reduce((sum, row) => sum + Math.max(0, Number(row.level) || 0), 0);
  return Math.max(1, total);
}

export function proficiencyBonus(level: number): number {
  return 2 + Math.floor((Math.max(1, level) - 1) / 4);
}

export function abilityMap(abilities: CharacterAbility[]): Record<AbilityKey, number> {
  const map = Object.fromEntries(abilityKeys.map((key) => [key, 10])) as Record<AbilityKey, number>;
  for (const ability of abilities) {
    map[ability.key] = Number(ability.score) || 10;
  }
  return map;
}

export function skillModifier(score: number, proficient: boolean, level: number): number {
  return abilityModifier(score) + (proficient ? proficiencyBonus(level) : 0);
}

export function savingThrowModifier(score: number, proficient: boolean, level: number): number {
  return skillModifier(score, proficient, level);
}

export function clampResource(currentValue: number, maxValue: number): number {
  return Math.max(0, Math.min(Number(currentValue) || 0, Math.max(0, Number(maxValue) || 0)));
}

const classHitDice: Record<string, number> = {
  artificer: 8,
  barbarian: 12,
  bard: 8,
  cleric: 8,
  druid: 8,
  fighter: 10,
  monk: 8,
  paladin: 10,
  ranger: 10,
  rogue: 8,
  sorcerer: 6,
  warlock: 8,
  wizard: 6
};

export function classHitDie(className: string): number {
  return classHitDice[className.trim().toLowerCase()] ?? 8;
}

export function hitDiceSummary(classes: CharacterClass[]): string {
  const grouped = new Map<number, number>();
  for (const row of classes) {
    const die = classHitDie(row.className);
    grouped.set(die, (grouped.get(die) ?? 0) + Math.max(0, Number(row.level) || 0));
  }

  return [...grouped.entries()]
    .filter(([, count]) => count > 0)
    .sort(([left], [right]) => right - left)
    .map(([die, count]) => `${count}d${die}`)
    .join(', ');
}

export type ModifierContext = {
  classes?: CharacterClass[];
  attackType?: 'melee_weapon' | 'ranged_weapon' | 'spell' | 'weapon';
  ability?: AbilityKey;
};

export type ResolvedBonus = {
  label: string;
  value: number;
};

export function modifierTargetMatches(target: string, candidates: string[]) {
  return candidates.some((candidate) => {
    if (target === candidate) return true;
    if (target.endsWith('.all')) return candidate.startsWith(target.slice(0, -4));
    return false;
  });
}

export function barbarianRageDamageBonus(classes: CharacterClass[] = []): number {
  const barbarianLevel = classes
    .filter((row) => row.className.toLowerCase() === 'barbarian')
    .reduce((sum, row) => sum + Math.max(0, Number(row.level) || 0), 0);

  if (barbarianLevel >= 16) return 4;
  if (barbarianLevel >= 9) return 3;
  if (barbarianLevel >= 1) return 2;
  return 0;
}

export function resolveModifierNumericValue(valueExpression: string | null | undefined, context: ModifierContext = {}) {
  if (!valueExpression) return 0;
  if (valueExpression === 'rage_damage_bonus') return barbarianRageDamageBonus(context.classes);
  const numeric = Number(valueExpression);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolvedNumericModifiers(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  modifierTypes: string[],
  context: ModifierContext = {}
): ResolvedBonus[] {
  return effects.flatMap((effect) =>
    effect.modifiers
      .filter((modifier) => modifierTypes.includes(modifier.modifierType) && modifierTargetMatches(modifier.target, candidates))
      .map((modifier) => ({
        label: effect.name,
        value: resolveModifierNumericValue(modifier.valueExpression, context)
      }))
      .filter((bonus) => bonus.value !== 0 || modifierTypes.includes('set'))
  );
}

export function resolvedFlatBonuses(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  context: ModifierContext = {}
): ResolvedBonus[] {
  return resolvedNumericModifiers(effects, candidates, ['bonus'], context);
}
