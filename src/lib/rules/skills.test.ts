import { describe, expect, it } from 'vitest';
import type { AbilityKey, ActiveCharacterEffect } from '$lib/types/character';
import { SKILL_CHECKS, findSkill, skillCandidates, skillCheckBonus } from './skills';

function bonusEffect(target: string, value: string, type = 'bonus'): ActiveCharacterEffect {
  return {
    id: 'e', effectId: 'e', effectKey: 'e', name: 'Test', sourceType: 'item', sourceName: 'Test', description: '',
    durationType: 'while_applicable', requiresConcentration: false, isCondition: false, isSelectable: false, remainingRounds: null,
    modifiers: [{
      target, modifierType: type, label: 'Test ring', valueExpression: value, defaultValueExpression: value,
      valueOverrideExpression: '', conditionExpression: '', priority: 0
    }]
  };
}

const scores = { str: 10, dex: 10, con: 10, int: 16, wis: 10, cha: 10 } as Record<AbilityKey, number>;
const nature = findSkill('nature')!;
const base = { abilityScores: scores, proficient: false, proficiencyBonus: 3, modifierSources: [], classes: [] };

describe('skills helper', () => {
  it('lists the 18 skills with unique keys', () => {
    expect(SKILL_CHECKS).toHaveLength(18);
    expect(new Set(SKILL_CHECKS.map((skill) => skill.key)).size).toBe(18);
  });

  it('targets the ability and the skill itself', () => {
    expect(skillCandidates(nature)).toEqual(['ability_check.int', 'ability_check.nature']);
  });

  it('adds the ability modifier only when not proficient', () => {
    expect(skillCheckBonus(base, nature).total).toBe(3);
  });

  it('adds proficiency when proficient', () => {
    expect(skillCheckBonus({ ...base, proficient: true }, nature).total).toBe(6);
  });

  it('adds a general ability-check bonus and a skill-specific bonus, and lists them', () => {
    const result = skillCheckBonus({
      ...base,
      modifierSources: [bonusEffect('ability_check.int', '2'), bonusEffect('ability_check.nature', '1'), bonusEffect('ability_check.wis', '5')]
    }, nature);
    expect(result.total).toBe(6);
    expect(result.bonuses).toHaveLength(2);
  });

  it('subtracts a penalty', () => {
    expect(skillCheckBonus({ ...base, modifierSources: [bonusEffect('ability_check.nature', '2', 'penalty')] }, nature).total).toBe(1);
  });
});
