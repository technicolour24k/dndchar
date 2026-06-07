import type { AbilityKey, CharacterAbility, CharacterClass } from '$lib/types/character';

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
