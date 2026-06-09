import { describe, expect, it } from 'vitest';
import {
  abilityModifier,
  barbarianRageDamageBonus,
  clampResource,
  hitDiceSummary,
  proficiencyBonus,
  resolvedFlatBonuses,
  resolvedNumericModifiers,
  skillModifier,
  totalLevel
} from './dnd5e';
import type { ActiveCharacterEffect } from '$lib/types/character';

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

  it('summarises hit dice by class hit die', () => {
    expect(hitDiceSummary([{ className: 'Fighter', level: 3 }, { className: 'Wizard', level: 2 }])).toBe('3d10, 2d6');
    expect(hitDiceSummary([{ className: 'Ranger', level: 4 }, { className: 'Paladin', level: 2 }])).toBe('6d10');
  });

  it('calculates skill modifiers with proficiency', () => {
    expect(skillModifier(16, true, 5)).toBe(6);
  });

  it('clamps resource values', () => {
    expect(clampResource(12, 10)).toBe(10);
    expect(clampResource(-3, 10)).toBe(0);
  });

  it('calculates barbarian rage damage bonus by barbarian level', () => {
    expect(barbarianRageDamageBonus([{ className: 'Barbarian', level: 1 }])).toBe(2);
    expect(barbarianRageDamageBonus([{ className: 'Barbarian', level: 9 }])).toBe(3);
    expect(barbarianRageDamageBonus([{ className: 'Barbarian', level: 16 }])).toBe(4);
    expect(barbarianRageDamageBonus([{ className: 'Fighter', level: 16 }])).toBe(0);
  });

  it('resolves active effect flat bonuses from modifier targets', () => {
    const rage: ActiveCharacterEffect = {
      id: 'active-rage',
      effectId: 'rage',
      effectKey: 'rage',
      name: 'Rage',
      sourceType: 'class_feature',
      sourceName: 'Rage',
      description: '',
      durationType: 'timed',
      requiresConcentration: false,
      isCondition: false,
      isSelectable: true,
      remainingRounds: null,
      modifiers: [
        {
          target: 'damage_roll.melee_weapon.str',
          modifierType: 'bonus',
          valueExpression: 'rage_damage_bonus',
          defaultValueExpression: 'rage_damage_bonus',
          valueOverrideExpression: '',
          conditionExpression: '',
          priority: 0
        }
      ]
    };

    expect(
      resolvedFlatBonuses([rage], ['damage_roll.melee_weapon.str'], {
        classes: [{ className: 'Barbarian', level: 9 }],
        attackType: 'melee_weapon',
        ability: 'str'
      })
    ).toEqual([{ label: 'Rage', value: 3 }]);
  });

  it('resolves non-bonus numeric modifiers by type', () => {
    const haste: ActiveCharacterEffect = {
      id: 'active-haste',
      effectId: 'haste',
      effectKey: 'haste',
      name: 'Haste',
      sourceType: 'spell',
      sourceName: 'Haste',
      description: '',
      durationType: 'concentration',
      requiresConcentration: true,
      isCondition: false,
      isSelectable: true,
      remainingRounds: null,
      modifiers: [
        {
          target: 'speed.all',
          modifierType: 'multiplier',
          valueExpression: '2',
          defaultValueExpression: '2',
          valueOverrideExpression: '',
          conditionExpression: '',
          priority: 0
        }
      ]
    };

    expect(resolvedNumericModifiers([haste], ['speed.walk'], ['multiplier'])).toEqual([{ label: 'Haste', value: 2 }]);
  });
});
