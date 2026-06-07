import { describe, expect, it } from 'vitest';
import { abilityModifier, clampResource, proficiencyBonus, skillModifier, totalLevel } from './dnd5e';

describe('D&D 5e helpers', () => {
  it('calculates ability modifiers', () => {
    expect(abilityModifier(10)).toBe(0);
    expect(abilityModifier(8)).toBe(-1);
    expect(abilityModifier(16)).toBe(3);
  });

  it('calculates proficiency bonus by level', () => {
    expect(proficiencyBonus(1)).toBe(2);
    expect(proficiencyBonus(5)).toBe(3);
    expect(proficiencyBonus(17)).toBe(6);
  });

  it('calculates total class level', () => {
    expect(totalLevel([{ className: 'Fighter', level: 3 }, { className: 'Wizard', level: 2 }])).toBe(5);
  });

  it('calculates skill modifiers with proficiency', () => {
    expect(skillModifier(16, true, 5)).toBe(6);
  });

  it('clamps resource values', () => {
    expect(clampResource(12, 10)).toBe(10);
    expect(clampResource(-3, 10)).toBe(0);
  });
});
