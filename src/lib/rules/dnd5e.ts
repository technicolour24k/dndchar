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

export type ModifierContext = {
  classes?: CharacterClass[];
  attackType?: 'melee_weapon' | 'ranged_weapon' | 'spell' | 'weapon';
  ability?: AbilityKey;
};

export type ResolvedBonus = {
  label: string;
  value: number;
};

function targetMatches(target: string, candidates: string[]) {
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

function resolveModifierValue(valueExpression: string | null | undefined, context: ModifierContext) {
  if (!valueExpression) return 0;
  if (valueExpression === 'rage_damage_bonus') return barbarianRageDamageBonus(context.classes);
  const numeric = Number(valueExpression);
  return Number.isFinite(numeric) ? numeric : 0;
}

export function resolvedFlatBonuses(
  effects: ActiveCharacterEffect[],
  candidates: string[],
  context: ModifierContext = {}
): ResolvedBonus[] {
  return effects.flatMap((effect) =>
    effect.modifiers
      .filter((modifier) => modifier.modifierType === 'bonus' && targetMatches(modifier.target, candidates))
      .map((modifier) => ({
        label: effect.name,
        value: resolveModifierValue(modifier.valueExpression, context)
      }))
      .filter((bonus) => bonus.value !== 0)
  );
}
