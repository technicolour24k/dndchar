import { describe, expect, it } from 'vitest';
import {
  abilityModifier,
  barbarianRageDamageBonus,
  clampResource,
  hitDiceSummary,
  effectiveCasterLevel,
  pactMagicSlots,
  proficiencyBonus,
  resolveResourceMaximum,
  rollDiceExpression,
  modifierConditionMatches,
  resolveAdvantageState,
  resolvedFlatBonuses,
  resolvedNumericModifiers,
  skillModifier,
  spellSaveDc,
  standardSpellSlotMaximums,
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

  it('calculates full 2014 multiclass spell slots', () => {
    const classes = [{ className: 'Wizard', level: 3 }, { className: 'Paladin', level: 4 }];
    expect(effectiveCasterLevel(classes)).toBe(5);
    expect(standardSpellSlotMaximums(classes).slice(0, 4)).toEqual([4, 3, 2, 0]);
    expect(effectiveCasterLevel([{ className: 'Fighter', subclassName: 'Eldritch Knight', level: 9 }])).toBe(3);
  });

  it('keeps Pact Magic separate from standard slots', () => {
    expect(pactMagicSlots([{ className: 'Warlock', level: 1 }])).toEqual({ level: 1, slots: 1 });
    expect(pactMagicSlots([{ className: 'Warlock', level: 11 }])).toEqual({ level: 5, slots: 3 });
  });

  it('calculates spell save DC with modifier bonuses', () => {
    expect(spellSaveDc(16, 5, [2])).toBe(16);
  });

  it('resolves safe resource maximum expressions', () => {
    expect(resolveResourceMaximum('3')).toBe(3);
    expect(resolveResourceMaximum('proficiency_bonus', { proficiencyBonus: 4 })).toBe(4);
    expect(resolveResourceMaximum('process.exit()', { level: 20 })).toBe(0);
  });

  it('rolls additive and subtractive resource expressions safely',()=>{
    expect(rollDiceExpression('2d4+3-1d6',()=>2)).toBe(5);
    expect(rollDiceExpression('process.exit()',()=>20)).toBe(0);
  });

  it('evaluates supported modifier conditions and rejects unknown predicates',()=>{
    const context={classes:[{className:'Barbarian',level:5}],ability:'str' as const,attackType:'melee_weapon' as const};
    expect(modifierConditionMatches('class:barbarian && ability:str',context)).toBe(true);
    expect(modifierConditionMatches('attack:ranged_weapon',context)).toBe(false);
    expect(modifierConditionMatches('user_supplied_javascript()',context)).toBe(false);
  });

  it('cancels advantage and disadvantage regardless of source count',()=>{
    const source=(name:string,modifierType:string):ActiveCharacterEffect=>({id:name,effectId:name,effectKey:name,name,
      sourceType:'effect',sourceName:name,description:'',durationType:'',requiresConcentration:false,isCondition:false,
      isSelectable:true,remainingRounds:null,modifiers:[{target:'attack_roll.all',modifierType,valueExpression:'',
        defaultValueExpression:'',valueOverrideExpression:'',conditionExpression:'',priority:0}]});
    expect(resolveAdvantageState([source('Blessing','advantage')],['attack_roll.weapon'])).toBe('advantage');
    expect(resolveAdvantageState([source('Blessing','advantage'),source('Poisoned','disadvantage')],['attack_roll.weapon'])).toBe('normal');
  });
});
