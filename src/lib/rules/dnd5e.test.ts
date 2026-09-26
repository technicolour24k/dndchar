import { describe, expect, it } from 'vitest';
import {
  abilityModifier,
  barbarianRageDamageBonus,
  clampResource,
  hitDiceSummary,
  effectiveCasterLevel,
  pactMagicSlots,
  proficiencyBonus,
  resolveCritThreshold,
  resolveD20Outcomes,
  resolveDicePool,
  resolveExtraDiceRolls,
  resolveModifierNumericValue,
  resolveResourceMaximum,
  resolveSpellDamage,
  rollD20Pool,
  rollDiceExpression,
  modifierConditionMatches,
  resolveAdvantageState,
  resolvedFlatBonuses,
  resolvedNumericModifiers,
  skillModifier,
  speedFt,
  speedPipeline,
  spellAttackBonus,
  spellSaveDc,
  standardSpellSlotMaximums,
  totalLevel
} from './dnd5e';
import type { ActiveCharacterEffect, EffectModifier } from '$lib/types/character';
import { rollWithModifiers } from './attackRoll';
import {
  manualOverrideLines,
  parseStatInput,
  readStatOverrides,
  resolveCharacterStats,
  resolveSpellcastingAbility,
  resolveStat,
  withManualLines,
  type CharacterStatInputs
} from './characterStats';

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
          label: '',
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
          label: '',
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

  it('lets spellSaveDc/spellAttackBonus take an explicit proficiency bonus instead of recomputing it from level', () => {
    expect(spellSaveDc(16, 5, [2], 6)).toBe(19);
    expect(spellAttackBonus(16, 5, [2], 6)).toBe(11);
  });

  it('folds a manual speed adjustment into the base, before any set modifier', () => {
    expect(speedPipeline([], {}, 10).value).toBe(40);

    const grappled: ActiveCharacterEffect = {
      id: 'active-grappled', effectId: 'grappled', effectKey: 'grappled', name: 'Grappled', sourceType: 'condition',
      sourceName: 'Grappled', description: '', durationType: '', requiresConcentration: false, isCondition: true,
      isSelectable: true, remainingRounds: null,
      modifiers: [{ target: 'speed.all', modifierType: 'set', label: '', valueExpression: '0', defaultValueExpression: '0',
        valueOverrideExpression: '', conditionExpression: '', priority: 0 }]
    };
    const grappledResult = speedPipeline([grappled], {}, 10);
    expect(grappledResult.value).toBe(0);
    expect(grappledResult.adjustmentReplacedBy).not.toBeNull();

    const hasted: ActiveCharacterEffect = {
      id: 'active-haste', effectId: 'haste', effectKey: 'haste', name: 'Haste', sourceType: 'spell', sourceName: 'Haste',
      description: '', durationType: 'concentration', requiresConcentration: true, isCondition: false, isSelectable: true,
      remainingRounds: null,
      modifiers: [{ target: 'speed.all', modifierType: 'multiplier', label: '', valueExpression: '2', defaultValueExpression: '2',
        valueOverrideExpression: '', conditionExpression: '', priority: 0 }]
    };
    expect(speedPipeline([hasted], {}, 10).value).toBe(80);

    expect(speedFt([hasted], {})).toBe(60);
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

  it('derives the advantage/disadvantage label from the net of a dice-pool resolution',()=>{
    const source=(name:string,modifierType:string):ActiveCharacterEffect=>({id:name,effectId:name,effectKey:name,name,
      sourceType:'effect',sourceName:name,description:'',durationType:'',requiresConcentration:false,isCondition:false,
      isSelectable:true,remainingRounds:null,modifiers:[{target:'attack_roll.all',modifierType,label:'',valueExpression:'',
        defaultValueExpression:'',valueOverrideExpression:'',conditionExpression:'',priority:0}]});
    expect(resolveAdvantageState([source('Blessing','advantage')],['attack_roll.weapon'])).toBe('advantage');
    expect(resolveAdvantageState([source('Blessing','advantage'),source('Poisoned','disadvantage')],['attack_roll.weapon'])).toBe('normal');
  });

  it('nets advantage/disadvantage sources by count, per modifier-primacy.md §3.3 (a deliberate departure from standard 5e binary cancellation)',()=>{
    expect(resolveDicePool(3,0)).toEqual({advantageCount:3,disadvantageCount:0,net:3,poolSize:4,direction:'highest'});
    expect(resolveDicePool(0,3)).toEqual({advantageCount:0,disadvantageCount:3,net:-3,poolSize:4,direction:'lowest'});
    expect(resolveDicePool(3,1)).toEqual({advantageCount:3,disadvantageCount:1,net:2,poolSize:3,direction:'highest'});
    expect(resolveDicePool(1,3)).toEqual({advantageCount:1,disadvantageCount:3,net:-2,poolSize:3,direction:'lowest'});
    expect(resolveDicePool(2,2)).toEqual({advantageCount:2,disadvantageCount:2,net:0,poolSize:1,direction:'flat'});
    expect(resolveDicePool(0,0)).toEqual({advantageCount:0,disadvantageCount:0,net:0,poolSize:1,direction:'flat'});
  });

  it('rolls a d20 pool of the requested size and takes the highest, lowest, or the single flat die',()=>{
    const scripted=[14,7,19,2];
    let index=0;
    const rollDie=()=>scripted[index++];
    expect(rollD20Pool(4,'highest',rollDie)).toEqual({rolls:[14,7,19,2],chosen:19});
    index=0;
    expect(rollD20Pool(4,'lowest',rollDie)).toEqual({rolls:[14,7,19,2],chosen:2});
    index=0;
    expect(rollD20Pool(1,'flat',rollDie)).toEqual({rolls:[14],chosen:14});
  });

  it('derives named, open-ended roll outcomes from a natural d20, per modifier-primacy.md §6.4',()=>{
    expect(resolveD20Outcomes(1)).toEqual(['critical_miss']);
    expect(resolveD20Outcomes(20)).toEqual(['critical_hit']);
    expect(resolveD20Outcomes(10)).toEqual([]);
    // A lowered crit threshold (e.g. a Champion Fighter's 19-20 range) widens which naturals
    // produce 'critical_hit', without the function itself knowing anything crit-specific.
    expect(resolveD20Outcomes(19,19)).toEqual(['critical_hit']);
    expect(resolveD20Outcomes(18,19)).toEqual([]);
  });

  it('resolves crit threshold as 20 by default, lowered by a crit_threshold.all penalty modifier',()=>{
    expect(resolveCritThreshold([])).toBe(20);
    const championFighter: ActiveCharacterEffect = {
      id: 'active-improved-crit', effectId: 'improved-crit', effectKey: 'improved-crit', name: 'Improved Critical',
      sourceType: 'class_feature', sourceName: 'Improved Critical', description: '', durationType: '',
      requiresConcentration: false, isCondition: false, isSelectable: true, remainingRounds: null,
      modifiers: [{ target: 'crit_threshold.all', modifierType: 'penalty', label: '', valueExpression: '1',
        defaultValueExpression: '1', valueOverrideExpression: '', conditionExpression: '', priority: 0 }]
    };
    expect(resolveCritThreshold([championFighter])).toBe(19);
  });

  it('matches "on:<outcome>" conditions against context.outcomes, per modifier-primacy.md §6.4',()=>{
    expect(modifierConditionMatches('on:critical_hit',{outcomes:['critical_hit']})).toBe(true);
    expect(modifierConditionMatches('on:critical_hit',{outcomes:['critical_miss']})).toBe(false);
    expect(modifierConditionMatches('on:critical_hit',{})).toBe(false);
    expect(modifierConditionMatches('class:barbarian && on:critical_hit',{classes:[{className:'Barbarian',level:5}],outcomes:['critical_hit']})).toBe(true);
  });

  it('resolves a sibling-derived value to the max of another Modifier on the same Container, per modifier-primacy.md §2.1',()=>{
    const baseDie: EffectModifier = { target:'damage_roll.melee_weapon.str', modifierType:'extra_die', label:'', valueExpression:'1d10',
      defaultValueExpression:'1d10', valueOverrideExpression:'', conditionExpression:'', priority:0 };
    const critBonus: EffectModifier = { target:'damage_roll.melee_weapon.str', modifierType:'bonus', label:'',
      valueExpression:'sibling:max:damage_roll.melee_weapon.str', defaultValueExpression:'sibling:max:damage_roll.melee_weapon.str',
      valueOverrideExpression:'', conditionExpression:'on:critical_hit', priority:1 };
    const siblings = [baseDie, critBonus];
    expect(resolveModifierNumericValue(critBonus.valueExpression,{},siblings,critBonus)).toBe(10);
    // A flat-value sibling resolves to itself, not just dice expressions.
    const flatSibling: EffectModifier = { ...baseDie, modifierType:'bonus', valueExpression:'4', defaultValueExpression:'4' };
    expect(resolveModifierNumericValue('sibling:max:damage_roll.melee_weapon.str',{},[flatSibling,critBonus],critBonus)).toBe(4);
    // No matching sibling on the container -> 0, not a thrown error.
    expect(resolveModifierNumericValue('sibling:max:nonexistent.target',{},siblings,critBonus)).toBe(0);
  });

  it('labels a resolved value with the modifier\'s own label when set, falling back to the Container name otherwise',()=>{
    const weapon: ActiveCharacterEffect = {
      id:'active-weapon', effectId:'weapon', effectKey:'weapon', name:'Flameheart Greatsword', sourceType:'item',
      sourceName:'Flameheart Greatsword', description:'', durationType:'while_applicable', requiresConcentration:false,
      isCondition:false, isSelectable:false, remainingRounds:null,
      modifiers:[
        { target:'damage_roll.melee_weapon.str', modifierType:'extra_die', label:'Flameheart Greatsword Attack',
          valueExpression:'1d10', defaultValueExpression:'1d10', valueOverrideExpression:'', conditionExpression:'', priority:0 },
        { target:'damage_roll.melee_weapon.str', modifierType:'bonus', label:'Critical Hit (max dice)',
          valueExpression:'sibling:max:damage_roll.melee_weapon.str', defaultValueExpression:'sibling:max:damage_roll.melee_weapon.str',
          valueOverrideExpression:'', conditionExpression:'on:critical_hit', priority:1 },
        { target:'damage_roll.melee_weapon.str', modifierType:'bonus', label:'', valueExpression:'1',
          defaultValueExpression:'1', valueOverrideExpression:'', conditionExpression:'', priority:2 }
      ]
    };
    const candidates=['damage_roll.melee_weapon.str'];
    expect(resolveExtraDiceRolls([weapon],candidates,{},()=>7)).toEqual([
      { label:'Flameheart Greatsword Attack', expression:'1d10', rolls:[7], value:7 }
    ]);
    expect(resolvedNumericModifiers([weapon],candidates,['bonus'],{outcomes:['critical_hit']})).toEqual([
      { label:'Critical Hit (max dice)', value:10 },
      { label:'Flameheart Greatsword', value:1 }
    ]);
  });

  it('resolves extra_die Modifiers with condition-awareness, including outcome-gated dice, per modifier-primacy.md §6.4',()=>{
    const bless: ActiveCharacterEffect = {
      id:'active-bless', effectId:'bless', effectKey:'bless', name:'Bless', sourceType:'spell', sourceName:'Bless',
      description:'', durationType:'concentration', requiresConcentration:true, isCondition:false, isSelectable:true,
      remainingRounds:null,
      modifiers:[{ target:'attack_roll.all', modifierType:'extra_die', label:'', valueExpression:'1d4', defaultValueExpression:'1d4',
        valueOverrideExpression:'', conditionExpression:'', priority:0 }]
    };
    const scripted=[3];let index=0;const rollDie=()=>scripted[index++];
    expect(resolveExtraDiceRolls([bless],['attack_roll.weapon'],{},rollDie)).toEqual([
      { label:'Bless', expression:'1d4', rolls:[3], value:3 }
    ]);

    const gatedWeapon: ActiveCharacterEffect = {
      id:'active-weapon', effectId:'weapon', effectKey:'weapon', name:'Flameheart Greatsword', sourceType:'item',
      sourceName:'Flameheart Greatsword', description:'', durationType:'while_applicable', requiresConcentration:false,
      isCondition:false, isSelectable:false, remainingRounds:null,
      modifiers:[
        { target:'damage_roll.melee_weapon.str', modifierType:'extra_die', label:'', valueExpression:'1d10',
          defaultValueExpression:'1d10', valueOverrideExpression:'', conditionExpression:'', priority:0 },
        { target:'damage_roll.melee_weapon.str', modifierType:'extra_die', label:'', valueExpression:'1d6',
          defaultValueExpression:'1d6', valueOverrideExpression:'', conditionExpression:'on:critical_hit', priority:1 }
      ]
    };
    const candidates=['damage_roll.melee_weapon.str'];
    // Normal hit: only the unconditioned base die rolls.
    let rolls=[7];index=0;
    const normalRollDie=()=>rolls[index++];
    expect(resolveExtraDiceRolls([gatedWeapon],candidates,{outcomes:[]},normalRollDie)).toEqual([
      { label:'Flameheart Greatsword', expression:'1d10', rolls:[7], value:7 }
    ]);
    // Critical hit: both the base die and the outcome-gated companion die roll.
    rolls=[7,5];index=0;
    const critRollDie=()=>rolls[index++];
    expect(resolveExtraDiceRolls([gatedWeapon],candidates,{outcomes:['critical_hit']},critRollDie)).toEqual([
      { label:'Flameheart Greatsword', expression:'1d10', rolls:[7], value:7 },
      { label:'Flameheart Greatsword', expression:'1d6', rolls:[5], value:5 }
    ]);
  });

  it('end to end: a single Container with a base damage Modifier and a sibling-derived, outcome-gated crit bonus resolves correctly on both a normal and a critical hit',()=>{
    const weapon: ActiveCharacterEffect = {
      id:'active-weapon', effectId:'weapon', effectKey:'weapon', name:'Flameheart Greatsword', sourceType:'item',
      sourceName:'Flameheart Greatsword', description:'', durationType:'while_applicable', requiresConcentration:false,
      isCondition:false, isSelectable:false, remainingRounds:null,
      modifiers:[
        { target:'damage_roll.melee_weapon.str', modifierType:'extra_die', label:'', valueExpression:'1d10',
          defaultValueExpression:'1d10', valueOverrideExpression:'', conditionExpression:'', priority:0 },
        { target:'damage_roll.melee_weapon.str', modifierType:'bonus', label:'', valueExpression:'sibling:max:damage_roll.melee_weapon.str',
          defaultValueExpression:'sibling:max:damage_roll.melee_weapon.str', valueOverrideExpression:'',
          conditionExpression:'on:critical_hit', priority:1 }
      ]
    };
    const candidates=['damage_roll.melee_weapon.str'];

    // Natural 12 -> no outcomes -> base die only, crit bonus does not apply.
    const normalOutcomes=resolveD20Outcomes(12,resolveCritThreshold([weapon]));
    expect(normalOutcomes).toEqual([]);
    let rolls=[7];let index=0;
    const normalExtraDice=resolveExtraDiceRolls([weapon],candidates,{outcomes:normalOutcomes},()=>rolls[index++]);
    expect(normalExtraDice).toEqual([{ label:'Flameheart Greatsword', expression:'1d10', rolls:[7], value:7 }]);
    const normalBonuses=resolvedNumericModifiers([weapon],candidates,['bonus'],{outcomes:normalOutcomes});
    expect(normalBonuses).toEqual([]);

    // Natural 20 -> critical_hit -> base die rolls AND the sibling-derived crit bonus (+10, the
    // base die's max) applies, each attributed separately.
    const critOutcomes=resolveD20Outcomes(20,resolveCritThreshold([weapon]));
    expect(critOutcomes).toEqual(['critical_hit']);
    rolls=[7];index=0;
    const critExtraDice=resolveExtraDiceRolls([weapon],candidates,{outcomes:critOutcomes},()=>rolls[index++]);
    expect(critExtraDice).toEqual([{ label:'Flameheart Greatsword', expression:'1d10', rolls:[7], value:7 }]);
    const critBonuses=resolvedNumericModifiers([weapon],candidates,['bonus'],{outcomes:critOutcomes});
    expect(critBonuses).toEqual([{ label:'Flameheart Greatsword', value:10 }]);
  });

  it('scales cantrip damage at character levels 5/11/17, per vtt-phase-3-magic-spec.md', () => {
    const fireBolt = {
      name: 'Fire Bolt', spellLevel: 0, resolutionType: 'attack' as const, damageType: 'fire', baseDice: '1d10',
      scaling: { kind: 'cantrip' as const, extraDice: '1d10', tiers: [5, 11, 17] }
    };
    const ctx = (casterLevel: number) => ({ castAtSlotLevel: 0, casterLevel, modifierSources: [] });
    expect(resolveSpellDamage(fireBolt, ctx(1)).diceExpression).toBe('1d10');
    expect(resolveSpellDamage(fireBolt, ctx(5)).diceExpression).toBe('1d10 + 1d10');
    expect(resolveSpellDamage(fireBolt, ctx(11)).diceExpression).toBe('1d10 + 1d10 + 1d10');
    expect(resolveSpellDamage(fireBolt, ctx(17)).diceExpression).toBe('1d10 + 1d10 + 1d10 + 1d10');
  });

  it('scales a leveled spell by slot levels cast above its minimum (upcasting), per vtt-phase-3-magic-spec.md', () => {
    const fireball = {
      name: 'Fireball', spellLevel: 3, resolutionType: 'save' as const, damageType: 'fire', baseDice: '8d6',
      saveAbility: 'dex' as const, saveEffect: 'half' as const,
      scaling: { kind: 'leveled' as const, extraDicePerSlotLevel: '1d6' }
    };
    const ctx = (castAtSlotLevel: number) => ({ castAtSlotLevel, casterLevel: 5, modifierSources: [] });
    expect(resolveSpellDamage(fireball, ctx(3)).diceExpression).toBe('8d6');
    expect(resolveSpellDamage(fireball, ctx(5)).diceExpression).toBe('8d6 + 1d6 + 1d6');
    expect(resolveSpellDamage(fireball, ctx(3)).saveAbility).toBe('dex');
    expect(resolveSpellDamage(fireball, ctx(3)).saveEffect).toBe('half');
  });

  it('doubles a spell\'s resolved dice pool via a "multiplier" Modifier targeting damage_roll.spell.<slug>, without touching flat bonuses', () => {
    const sleep = {
      name: 'Sleep', spellLevel: 1, resolutionType: 'auto' as const, damageType: '', baseDice: '5d8',
      scaling: { kind: 'none' as const }
    };
    const doublingItem: ActiveCharacterEffect = {
      id: 'active-sleep-doubler', effectId: 'sleep-doubler', effectKey: 'sleep-doubler', name: 'Somnolent Rod',
      sourceType: 'item', sourceName: 'Somnolent Rod', description: '', durationType: 'while_applicable',
      requiresConcentration: false, isCondition: false, isSelectable: false, remainingRounds: null,
      modifiers: [
        { target: 'damage_roll.spell.sleep', modifierType: 'multiplier', label: '', valueExpression: '2',
          defaultValueExpression: '2', valueOverrideExpression: '', conditionExpression: '', priority: 0 },
        { target: 'damage_roll.spell.sleep', modifierType: 'bonus', label: '', valueExpression: '3',
          defaultValueExpression: '3', valueOverrideExpression: '', conditionExpression: '', priority: 1 }
      ]
    };
    const profile = resolveSpellDamage(sleep, { castAtSlotLevel: 1, casterLevel: 5, modifierSources: [doublingItem] });
    expect(profile.diceExpression).toBe('5d8 + 5d8');
    expect(profile.flatBonuses).toEqual([{ label: 'Somnolent Rod', value: 3 }]);
  });
});

describe('stat overrides', () => {
  const simplePipeline = (base: number) => (adjustment: number) => ({ value: base + adjustment });

  it('gives the computed value when there is no override entry', () => {
    const stat = resolveStat(undefined, simplePipeline(10));
    expect(stat).toMatchObject({ computed: 10, adjusted: 10, adjustment: 0, value: 10, isAdjusted: false, isOverridden: false });
  });

  it('folds a manual adjustment into a simple pipeline', () => {
    const stat = resolveStat({ adjustment: 3, override: null }, simplePipeline(10));
    expect(stat).toMatchObject({ computed: 10, adjusted: 13, adjustment: 3, value: 13, isAdjusted: true, isOverridden: false });
  });

  it('lets a hard override win over an adjustment', () => {
    const stat = resolveStat({ adjustment: 3, override: 20 }, simplePipeline(10));
    expect(stat).toMatchObject({ computed: 10, adjusted: 13, override: 20, value: 20, isAdjusted: true, isOverridden: true });
  });

  it('treats override: 0 as a real override, not falsy/absent', () => {
    const stat = resolveStat({ adjustment: 0, override: 0 }, simplePipeline(10));
    expect(stat).toMatchObject({ value: 0, isOverridden: true });
  });

  it('clamps the adjusted value to opts.min with a negative adjustment', () => {
    const stat = resolveStat({ adjustment: -50, override: null }, simplePipeline(10), { min: 0 });
    expect(stat).toMatchObject({ computed: 10, adjusted: 0, value: 0 });
  });

  it('clamps a hard override to opts.min too, not just the adjusted value - the invariant must hold for every caller, not only the UI that happens to clamp on write', () => {
    const stat = resolveStat({ adjustment: 0, override: -20 }, simplePipeline(10), { min: 0 });
    expect(stat).toMatchObject({ override: 0, value: 0, isOverridden: true });
  });

  it('passes adjustmentReplacedBy through from the pipeline', () => {
    const pipeline = (adjustment: number) => ({ value: 0, adjustmentReplacedBy: adjustment !== 0 ? 'Grappled' : null });
    const stat = resolveStat({ adjustment: 10, override: null }, pipeline);
    expect(stat.adjustmentReplacedBy).toBe('Grappled');
  });

  it('reads statOverrides tolerantly, dropping junk and default entries', () => {
    expect(readStatOverrides(null)).toEqual({});
    expect(readStatOverrides(undefined)).toEqual({});
    expect(readStatOverrides({ statOverrides: 'nope' })).toEqual({});
    expect(readStatOverrides({ statOverrides: [] })).toEqual({});
    expect(readStatOverrides({
      statOverrides: {
        armorClass: { adjustment: 2, override: 18 },
        unknownKey: { adjustment: 5, override: null },
        initiative: 'abc',
        speed: { adjustment: '3', override: null },
        proficiency: { adjustment: 0, override: null }
      }
    })).toEqual({
      armorClass: { adjustment: 2, override: 18 },
      speed: { adjustment: 3, override: null }
    });
  });

  it('parses stat input strings, taking the leading signed integer', () => {
    expect(parseStatInput('+3')).toBe(3);
    expect(parseStatInput('3')).toBe(3);
    expect(parseStatInput('-1')).toBe(-1);
    expect(parseStatInput('30 ft.')).toBe(30);
    expect(parseStatInput('30ft')).toBe(30);
    expect(parseStatInput('')).toBe('blank');
    expect(parseStatInput('  ')).toBe('blank');
    expect(parseStatInput('fast')).toBe('invalid');
    expect(parseStatInput('2.6')).toBe(2);
  });

  it('builds manual-override breakdown lines for adjust-only, override-only, both, and set-replaced', () => {
    const fmt = (n: number) => String(n);
    expect(manualOverrideLines(resolveStat(undefined, simplePipeline(10)), fmt)).toEqual([]);

    expect(manualOverrideLines(resolveStat({ adjustment: 3, override: null }, simplePipeline(10)), fmt)).toEqual([
      'Calculated: 10', 'Manual adjustment: +3', 'Adjusted: 13', 'Total: 13'
    ]);

    expect(manualOverrideLines(resolveStat({ adjustment: 0, override: 18 }, simplePipeline(10)), fmt)).toEqual([
      'Calculated: 10', 'Manual override: 18 (computed: 10)', 'Total: 18'
    ]);

    expect(manualOverrideLines(resolveStat({ adjustment: 3, override: 18 }, simplePipeline(10)), fmt)).toEqual([
      'Calculated: 10', 'Manual adjustment: +3 (not applied - overridden)', 'Manual override: 18 (computed: 13)', 'Total: 18'
    ]);

    const setReplacedPipeline = (adjustment: number) => ({ value: 0, adjustmentReplacedBy: adjustment !== 0 ? 'Grappled' : null });
    expect(manualOverrideLines(resolveStat({ adjustment: 10, override: null }, setReplacedPipeline), fmt)).toEqual([
      'Calculated: 0', 'Manual adjustment: +10 (replaced by Grappled)', 'Total: 0'
    ]);
  });

  it('withManualLines leaves baseLines untouched with no manual state, otherwise swaps the trailing Total for the manual section', () => {
    const fmt = (n: number) => String(n);
    const base = ['Base: 10', 'Total: 10'];
    expect(withManualLines(base, resolveStat(undefined, simplePipeline(10)), fmt)).toBe(base);

    expect(withManualLines(base, resolveStat({ adjustment: 0, override: 18 }, simplePipeline(10)), fmt)).toEqual([
      'Base: 10', 'Calculated: 10', 'Manual override: 18 (computed: 10)', 'Total: 18'
    ]);
  });
});

describe('resolveCharacterStats', () => {
  const abilityScores = { str: 10, dex: 14, con: 10, int: 16, wis: 14, cha: 10 };
  const baseInput: CharacterStatInputs = {
    classes: [{ className: 'Wizard', level: 5 }],
    abilityScores,
    modifierSources: [],
    inventory: [],
    savingThrowProficiencies: ['wis'],
    skillProficiencies: ['perception'],
    spellcastingAbility: 'int',
    overrides: {}
  };

  const grappled: ActiveCharacterEffect = {
    id: 'active-grappled', effectId: 'grappled', effectKey: 'grappled', name: 'Grappled', sourceType: 'condition',
    sourceName: 'Grappled', description: '', durationType: '', requiresConcentration: false, isCondition: true,
    isSelectable: true, remainingRounds: null,
    modifiers: [{ target: 'speed.all', modifierType: 'set', label: '', valueExpression: '0', defaultValueExpression: '0',
      valueOverrideExpression: '', conditionExpression: '', priority: 0 }]
  };

  it('matches the existing helper outputs when there are no overrides', () => {
    const stats = resolveCharacterStats(baseInput);
    expect(stats.level).toBe(5);
    expect(stats.proficiency.value).toBe(proficiencyBonus(5));
    expect(stats.armorClass.value).toBe(10 + abilityModifier(abilityScores.dex));
    expect(stats.passivePerception.value).toBe(10 + abilityModifier(abilityScores.wis) + proficiencyBonus(5));
    expect(stats.passiveInsight.value).toBe(10 + abilityModifier(abilityScores.wis));
    expect(stats.spellSaveDc.value).toBe(spellSaveDc(abilityScores.int, 5));
    expect(stats.spellAttackBonus.value).toBe(spellAttackBonus(abilityScores.int, 5));
    expect(stats.savingThrows.wis).toBe(abilityModifier(abilityScores.wis) + proficiencyBonus(5));
    expect(stats.savingThrows.str).toBe(abilityModifier(abilityScores.str));
  });

  it('cascades a proficiency override into proficient passives, spell DC/attack, and proficient saves - but not non-proficient ones', () => {
    const stats = resolveCharacterStats({ ...baseInput, overrides: { proficiency: { adjustment: 0, override: 6 } } });
    const delta = 6 - proficiencyBonus(5);
    expect(stats.proficiency.value).toBe(6);
    expect(stats.passivePerception.value).toBe(10 + abilityModifier(abilityScores.wis) + proficiencyBonus(5) + delta);
    expect(stats.passiveInsight.value).toBe(10 + abilityModifier(abilityScores.wis)); // not proficient, untouched
    expect(stats.spellSaveDc.value).toBe(spellSaveDc(abilityScores.int, 5) + delta);
    expect(stats.spellAttackBonus.value).toBe(spellAttackBonus(abilityScores.int, 5) + delta);
    expect(stats.savingThrows.wis).toBe(abilityModifier(abilityScores.wis) + proficiencyBonus(5) + delta);
    expect(stats.savingThrows.str).toBe(abilityModifier(abilityScores.str)); // not proficient, untouched
  });

  it('cascades a proficiency adjustment the same way an override does', () => {
    const stats = resolveCharacterStats({ ...baseInput, overrides: { proficiency: { adjustment: 1, override: null } } });
    expect(stats.proficiency.value).toBe(proficiencyBonus(5) + 1);
    expect(stats.spellSaveDc.value).toBe(spellSaveDc(abilityScores.int, 5) + 1);
    expect(stats.savingThrows.wis).toBe(abilityModifier(abilityScores.wis) + proficiencyBonus(5) + 1);
  });

  it('lets a spell DC override win even with a proficiency override also set', () => {
    const stats = resolveCharacterStats({
      ...baseInput,
      overrides: { proficiency: { adjustment: 0, override: 6 }, spellSaveDc: { adjustment: 0, override: 20 } }
    });
    expect(stats.spellSaveDc.value).toBe(20);
    expect(stats.proficiency.value).toBe(6);
  });

  it('applies a plain AC adjustment as an extra term', () => {
    const stats = resolveCharacterStats({ ...baseInput, overrides: { armorClass: { adjustment: 1, override: null } } });
    expect(stats.armorClass.value).toBe(10 + abilityModifier(abilityScores.dex) + 1);
  });

  it('resolves speed adjustment/override against a set modifier exactly per the precedence rule', () => {
    const grappledAdjusted = resolveCharacterStats({ ...baseInput, modifierSources: [grappled], overrides: { speed: { adjustment: 10, override: null } } });
    expect(grappledAdjusted.speed.value).toBe(0);
    expect(grappledAdjusted.speed.adjustmentReplacedBy).not.toBeNull();

    const grappledOverridden = resolveCharacterStats({ ...baseInput, modifierSources: [grappled], overrides: { speed: { adjustment: 0, override: 40 } } });
    expect(grappledOverridden.speed.value).toBe(40);

    const freeAdjusted = resolveCharacterStats({ ...baseInput, overrides: { speed: { adjustment: 10, override: null } } });
    expect(freeAdjusted.speed.value).toBe(40);
  });

  it('resolves the spellcasting ability fallback chain: class -> metadata -> int', () => {
    expect(resolveSpellcastingAbility([{ className: 'Cleric', level: 3, spellcastingAbility: 'wis' }], {})).toBe('wis');
    expect(resolveSpellcastingAbility([{ className: 'Sorcerer', level: 3 }], { spellcastingAbility: 'CHA' })).toBe('cha');
    expect(resolveSpellcastingAbility([{ className: 'Sorcerer', level: 3 }], { spellcastingAbility: 'not-a-key' })).toBe('int');
    expect(resolveSpellcastingAbility([], {})).toBe('int');
  });
});

describe('rollWithModifiers flatModifiersIncluded', () => {
  it('skips the flat bonus/penalty sum when the caller already folded it into `modifier`, to avoid double-counting', () => {
    const source: ActiveCharacterEffect = {
      id: 'active-ring', effectId: 'ring', effectKey: 'ring', name: 'Ring of Initiative', sourceType: 'item',
      sourceName: 'Ring of Initiative', description: '', durationType: 'while_applicable', requiresConcentration: false,
      isCondition: false, isSelectable: false, remainingRounds: null,
      modifiers: [{ target: 'initiative', modifierType: 'bonus', label: '', valueExpression: '2', defaultValueExpression: '2',
        valueOverrideExpression: '', conditionExpression: '', priority: 0 }]
    };
    const rollDie = () => 10;
    expect(rollWithModifiers([source], 5, ['initiative'], [], rollDie).total).toBe(17);
    expect(rollWithModifiers([source], 5, ['initiative'], [], rollDie, { flatModifiersIncluded: true }).total).toBe(15);
  });
});
