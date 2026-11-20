import { abilityModifier, resolvedAdditiveModifiers, type ResolvedBonus } from '$lib/rules/dnd5e';
import type { ActiveCharacterEffect, AbilityKey, CharacterClass } from '$lib/types/character';

// The 18 skills and the skill-check bonus maths, shared by the character sheet and the server
// (forage rolls its skill check server-side). Pure: no DB, no randomness.

export type SkillCheck = { key: string; name: string; ability: AbilityKey };

export const SKILL_CHECKS: SkillCheck[] = [
  { key: 'acrobatics', name: 'Acrobatics', ability: 'dex' },
  { key: 'animal_handling', name: 'Animal Handling', ability: 'wis' },
  { key: 'arcana', name: 'Arcana', ability: 'int' },
  { key: 'athletics', name: 'Athletics', ability: 'str' },
  { key: 'deception', name: 'Deception', ability: 'cha' },
  { key: 'history', name: 'History', ability: 'int' },
  { key: 'insight', name: 'Insight', ability: 'wis' },
  { key: 'intimidation', name: 'Intimidation', ability: 'cha' },
  { key: 'investigation', name: 'Investigation', ability: 'int' },
  { key: 'medicine', name: 'Medicine', ability: 'wis' },
  { key: 'nature', name: 'Nature', ability: 'int' },
  { key: 'perception', name: 'Perception', ability: 'wis' },
  { key: 'performance', name: 'Performance', ability: 'cha' },
  { key: 'persuasion', name: 'Persuasion', ability: 'cha' },
  { key: 'religion', name: 'Religion', ability: 'int' },
  { key: 'sleight_of_hand', name: 'Sleight of Hand', ability: 'dex' },
  { key: 'stealth', name: 'Stealth', ability: 'dex' },
  { key: 'survival', name: 'Survival', ability: 'wis' }
];

export function findSkill(key: string): SkillCheck | undefined {
  return SKILL_CHECKS.find((skill) => skill.key === key);
}

/** The modifier targets a skill check resolves against (its ability's checks, and the skill itself). */
export function skillCandidates(skill: { key: string; ability: AbilityKey }): string[] {
  return [`ability_check.${skill.ability}`, `ability_check.${skill.key}`];
}

export type SkillCheckInput = {
  abilityScores: Record<AbilityKey, number>;
  proficient: boolean;
  proficiencyBonus: number;
  modifierSources: ActiveCharacterEffect[];
  classes: CharacterClass[];
};

/** Just the modifier-sourced bonuses/penalties for a skill (the audit lines under the ability mod). */
export function skillModifierBonuses(
  modifierSources: ActiveCharacterEffect[],
  classes: CharacterClass[],
  skill: { key: string; ability: AbilityKey }
): ResolvedBonus[] {
  return resolvedAdditiveModifiers(modifierSources, skillCandidates(skill), { classes });
}

/** Ability modifier + proficiency (if proficient) + modifier-sourced bonuses, with the bonuses listed. */
export function skillCheckBonus(input: SkillCheckInput, skill: { key: string; ability: AbilityKey }): { total: number; bonuses: ResolvedBonus[] } {
  const bonuses = skillModifierBonuses(input.modifierSources, input.classes, skill);
  const total = abilityModifier(input.abilityScores[skill.ability])
    + (input.proficient ? input.proficiencyBonus : 0)
    + bonuses.reduce((sum, bonus) => sum + bonus.value, 0);
  return { total, bonuses };
}
