import { describe, expect, it } from 'vitest';
import type { ActiveCharacterEffect, InventoryItem } from '$lib/types/character';
import {
  adjustPrimaryDamageDice,
  applyDisabled,
  appliedEffectRowIds,
  collectAdvantageSources,
  defaultRollChoices,
  poolSummary,
  previewAdvantage,
  rollAttack,
  rollDamage,
  rollManualAttack,
  rollWithModifiers,
  situationalAdvantageSources,
  spellAttackCandidates,
  type AttackPool
} from './attackRoll';
import { mergeDiceTerms, modifierConditionMatches, modifierTargetMatches, resolveSpellDamage } from './dnd5e';

// A scripted die: hands back the given values in order, then 1s. Also records every call.
function scripted(values: number[]) {
  const calls: number[] = [];
  const rollDie = (sides: number) => {
    calls.push(sides);
    return values[calls.length - 1] ?? 1;
  };
  return { rollDie, calls };
}

function effect(id: string, name: string, modifiers: Array<{ target?: string; type: string; condition?: string; label?: string; value?: string }>): ActiveCharacterEffect {
  return {
    id, effectId: id, effectKey: id, name, sourceType: 'item', sourceName: name, description: '',
    durationType: 'while_applicable', requiresConcentration: false, isCondition: false, isSelectable: false, remainingRounds: null,
    modifiers: modifiers.map((entry) => ({
      target: entry.target ?? 'attack_roll.all', modifierType: entry.type, label: entry.label ?? '',
      valueExpression: entry.value ?? '', defaultValueExpression: entry.value ?? '', valueOverrideExpression: '',
      conditionExpression: entry.condition ?? '', priority: 0
    }))
  };
}

const adv = (id: string, name = id) => effect(id, name, [{ type: 'advantage' }]);
const dis = (id: string, name = id) => effect(id, name, [{ type: 'disadvantage' }]);
const candidates = ['attack_roll.weapon'];

describe('modifierTargetMatches hardening', () => {
  it('matches .all against children but not against a look-alike family', () => {
    expect(modifierTargetMatches('attack_roll.all', ['attack_roll.weapon'])).toBe(true);
    expect(modifierTargetMatches('attack_roll.all', ['attack_roll_against.weapon'])).toBe(false);
    expect(modifierTargetMatches('attacks_against.all', ['attack_roll.weapon'])).toBe(false);
    expect(modifierTargetMatches('attacks_against.all', ['attacks_against.melee_weapon'])).toBe(true);
  });
});

describe('within: / beyond: conditions', () => {
  it('compares against the distance, and is false when it is unknown', () => {
    expect(modifierConditionMatches('within:5', { distanceFt: 5 })).toBe(true);
    expect(modifierConditionMatches('within:5', { distanceFt: 10 })).toBe(false);
    expect(modifierConditionMatches('within:5', {})).toBe(false);
    expect(modifierConditionMatches('beyond:5', { distanceFt: 5 })).toBe(false);
    expect(modifierConditionMatches('beyond:5', { distanceFt: 10 })).toBe(true);
    expect(modifierConditionMatches('beyond:5', {})).toBe(false);
  });
});

describe('collectAdvantageSources', () => {
  it('gives stable ids, and two Containers granting advantage give two sources', () => {
    const sources = [adv('a', 'Ring'), adv('b', 'Boots')];
    const first = collectAdvantageSources(sources, candidates, {}, 'attacker');
    const second = collectAdvantageSources(sources, candidates, {}, 'attacker');
    expect(first).toHaveLength(2);
    expect(first.map((source) => source.id)).toEqual(second.map((source) => source.id));
    expect(new Set(first.map((source) => source.id)).size).toBe(2);
  });

  it('skips sources whose condition does not hold', () => {
    const gated = effect('prone', 'Prone', [{ type: 'advantage', condition: 'within:5' }]);
    expect(collectAdvantageSources([gated], candidates, { distanceFt: 5 }, 'target')).toHaveLength(1);
    expect(collectAdvantageSources([gated], candidates, { distanceFt: 10 }, 'target')).toHaveLength(0);
    expect(collectAdvantageSources([gated], candidates, {}, 'target')).toHaveLength(0);
  });
});

describe('situational sources', () => {
  it('clamps each counter to 0-5 independently', () => {
    const sources = situationalAdvantageSources(9, -1);
    expect(sources.filter((source) => source.kind === 'advantage')).toHaveLength(5);
    expect(sources.filter((source) => source.kind === 'disadvantage')).toHaveLength(0);
  });

  it('cannot be switched off with applyDisabled', () => {
    const sources = situationalAdvantageSources(1, 0);
    expect(applyDisabled(sources, [sources[0].id])[0].applied).toBe(true);
  });
});

describe('rollWithModifiers stacking', () => {
  it('nets 2 attacker adv + 1 condition dis + 1 situational dis to 0 and rolls one flat die', () => {
    const attacker = [adv('ring', 'Ring'), adv('boots', 'Boots')];
    const conditionSources = collectAdvantageSources([dis('poisoned', 'Poisoned')], candidates, {}, 'attacker_condition');
    const { rollDie, calls } = scripted([14]);
    const result = rollWithModifiers(attacker, 3, candidates, [], rollDie, {
      extraAdvantageSources: [...conditionSources, ...situationalAdvantageSources(0, 1)]
    });
    expect(result.pool.net).toBe(0);
    expect(result.pool.size).toBe(1);
    expect(result.pool.direction).toBe('flat');
    expect(result.pool.manualDisadvantage).toBe(1);
    expect(result.pool.manualAdvantage).toBe(0);
    expect(calls).toEqual([20]);
    expect(result.advantageSources).toHaveLength(4);
    expect(result.text).toContain('+1 Advantage: Ring');
    expect(result.text).toContain("+1 Disadvantage: Poisoned (attacker's condition)");
    expect(result.text).toContain('+1 Disadvantage: Situational (manual)');
    expect(result.text).toContain('Net 0 (2 adv, 2 dis): flat, rolled 1d20 [14]');
  });

  it('lets both counters be non-zero: (2, 1) is net +1, size 2', () => {
    const { rollDie, calls } = scripted([4, 17]);
    const result = rollWithModifiers([], 0, candidates, [], rollDie, { extraAdvantageSources: situationalAdvantageSources(2, 1) });
    expect(result.pool.net).toBe(1);
    expect(result.pool.size).toBe(2);
    expect(calls).toHaveLength(2);
    expect(result.natural).toBe(17);
  });

  it('(3, 0) plus one condition dis is net +2, size 3', () => {
    const condition = collectAdvantageSources([dis('poisoned', 'Poisoned')], candidates, {}, 'attacker_condition');
    const result = rollWithModifiers([], 0, candidates, [], scripted([12, 17, 5]).rollDie, {
      extraAdvantageSources: [...condition, ...situationalAdvantageSources(3, 0)]
    });
    expect(result.pool.net).toBe(2);
    expect(result.pool.size).toBe(3);
    expect(result.text).toContain('Net +2 (3 adv, 1 dis): rolled 3d20 [12, 17, 5], kept 17 (highest)');
  });

  it('shows Not applied for a disabled source and drops it from the pool', () => {
    const sources = [adv('ring', 'Ring')];
    const [source] = collectAdvantageSources(sources, candidates, {}, 'attacker');
    const result = rollWithModifiers(sources, 0, candidates, [], scripted([9]).rollDie, { disabledSourceIds: [source.id] });
    expect(result.pool.size).toBe(1);
    expect(result.text).toContain('Not applied: +1 Advantage: Ring');
  });

  it('gates conditional sources on the context', () => {
    const prone = effect('prone', 'Prone', [{ type: 'advantage', condition: 'within:5' }]);
    expect(rollWithModifiers([prone], 0, candidates, [], scripted([5]).rollDie, { context: { distanceFt: 5 } }).pool.size).toBe(1 + 1);
    expect(rollWithModifiers([prone], 0, candidates, [], scripted([5]).rollDie, { context: { distanceFt: 10 } }).pool.size).toBe(1);
    expect(rollWithModifiers([prone], 0, candidates, [], scripted([5]).rollDie).pool.size).toBe(1);
  });

  it('gates conditional flat bonuses on the context too', () => {
    const gated = effect('b', 'Bless-ish', [{ type: 'bonus', value: '3', condition: 'class:barbarian' }]);
    const rollDie = () => 10;
    expect(rollWithModifiers([gated], 0, candidates, [], rollDie).total).toBe(10);
    expect(rollWithModifiers([gated], 0, candidates, [], rollDie, { context: { classes: [{ className: 'Barbarian', level: 1 }] } }).total).toBe(13);
  });

  it('keeps the old text when there are no sources at all', () => {
    expect(rollWithModifiers([], 2, candidates, [], () => 10).text).toBe('d20 10\n10 + 2 = 12');
  });

  it('uses the kept die for outcomes: [1, 20] at net +1 is a crit, at net -1 a critical miss', () => {
    const high = rollAttack(item(), { modifierSources: [adv('a')], abilityScores: scores(), proficiencyBonus: 2, classes: [], rollDie: scripted([1, 20]).rollDie });
    expect(high.attackNatural).toBe(20);
    expect(high.outcomes).toContain('critical_hit');
    const low = rollAttack(item(), { modifierSources: [dis('a')], abilityScores: scores(), proficiencyBonus: 2, classes: [], rollDie: scripted([1, 20]).rollDie });
    expect(low.attackNatural).toBe(1);
    expect(low.outcomes).toContain('critical_miss');
  });
});

function scores() {
  return { str: 14, dex: 10, con: 10, int: 10, wis: 10, cha: 10 };
}

function item(damageRolls = '2d6'): InventoryItem {
  return {
    name: 'Longsword', category: 'weapon', location: 'equipped', quantity: 1, equipped: true, isEquipment: true,
    acBonus: 0, toHitBonus: 0, damageBonus: 0, attackAbility: 'str', proficient: true, damageRolls,
    effects: '', abilityBonuses: {}, notes: ''
  };
}

describe('ability-gated modifiers', () => {
  // One Container: advantage on all saves and all ability checks, but only for DEX rolls.
  const dexOnly = effect('boots', 'Boots of Dexterity', [
    { target: 'saving_throw.all', type: 'advantage', condition: 'ability:dex' },
    { target: 'ability_check.all', type: 'advantage', condition: 'ability:dex' }
  ]);
  const poolSize = (candidates: string[], ability: 'dex' | 'wis') =>
    rollWithModifiers([dexOnly], 0, candidates, [], scripted([5, 6]).rollDie, { context: { ability } }).pool.size;

  it('applies to a Dex save and a Stealth check', () => {
    expect(poolSize(['saving_throw.dex'], 'dex')).toBe(2);
    expect(poolSize(['ability_check.dex', 'ability_check.stealth'], 'dex')).toBe(2);
  });
  it('does not apply to a Wis save', () => {
    expect(poolSize(['saving_throw.wis'], 'wis')).toBe(1);
  });
  it('does not apply when the roll passes no ability', () => {
    expect(rollWithModifiers([dexOnly], 0, ['saving_throw.dex'], [], scripted([5]).rollDie).pool.size).toBe(1);
  });
});

describe('previewAdvantage', () => {
  it('matches what rollWithModifiers would roll', () => {
    const sources = [adv('a', 'Ring'), dis('b', 'Poisoned')];
    const preview = previewAdvantage(sources, candidates, {}, situationalAdvantageSources(1, 0));
    expect(preview.sources).toHaveLength(3);
    expect(preview.pool.net).toBe(1);
    const disabled = previewAdvantage(sources, candidates, {}, [], [preview.sources[1].id]);
    expect(disabled.pool.net).toBe(1);
    expect(disabled.sources[1].applied).toBe(false);
  });
});

describe('poolSummary', () => {
  const pool = (overrides: Partial<AttackPool>): AttackPool => ({
    size: 1, net: 0, direction: 'flat', advantage: 0, disadvantage: 0, manualAdvantage: 0, manualDisadvantage: 0, rolls: [10], kept: 10, ...overrides
  });
  it('is empty for a plain single die', () => expect(poolSummary(pool({}))).toBe(''));
  it('describes an advantage pool', () => {
    expect(poolSummary(pool({ size: 3, net: 2, direction: 'highest', rolls: [1, 17, 4], kept: 17 }))).toBe('3d20 adv x2, keeps 17');
  });
  it('describes a disadvantage pool with a manual part', () => {
    expect(poolSummary(pool({ size: 2, net: -1, direction: 'lowest', rolls: [1, 9], kept: 1, manualDisadvantage: 1 }))).toBe('2d20 dis x1, keeps 1; manual +1 dis');
  });
  it('still reports manual points on a flat roll', () => {
    expect(poolSummary(pool({ manualAdvantage: 1, manualDisadvantage: 1 }))).toBe('1d20 flat; manual +1 adv, manual +1 dis');
  });
});

describe('adjustPrimaryDamageDice (INTERIM)', () => {
  it('adds a die to the primary dice', () => {
    expect(adjustPrimaryDamageDice('2d6', 1)).toEqual({ expression: '3d6', applied: 1, auditLine: '+1 damage die (manual): 2d6 -> 3d6' });
  });
  it('clamps to one die', () => {
    expect(adjustPrimaryDamageDice('2d6', -3)).toEqual({ expression: '1d6', applied: -1, auditLine: '-3 damage dice (manual, clamped to 1): 2d6 -> 1d6' });
  });
  it('merges same-size terms', () => {
    expect(adjustPrimaryDamageDice('1d10 + 1d10', -1).expression).toBe('1d10');
  });
  it('only touches the first die size', () => {
    expect(adjustPrimaryDamageDice('1d8 + 1d6', 1).expression).toBe('2d8 + 1d6');
  });
  it('ignores an expression with no dice', () => {
    expect(adjustPrimaryDamageDice('1', 2)).toEqual({ expression: '1', applied: 0, auditLine: 'Manual damage dice ignored: no dice to adjust' });
  });
  it('does nothing at delta 0', () => {
    expect(adjustPrimaryDamageDice('2d6', 0)).toEqual({ expression: '2d6', applied: 0, auditLine: null });
  });
  it('clamps the delta to 5', () => {
    expect(adjustPrimaryDamageDice('1d4', 9).expression).toBe('6d4');
  });
  it('reports applied 0 when already at one die', () => {
    const result = adjustPrimaryDamageDice('1d8', -4);
    expect(result.applied).toBe(0);
    expect(result.auditLine).toBe('-4 damage dice (manual, clamped to 1): 1d8 -> 1d8');
  });
});

describe('rollAttack with manual damage dice', () => {
  it('rolls three d6 for +1 on 2d6 and puts the manual line first', () => {
    const { rollDie, calls } = scripted([10, 1, 2, 3]);
    const result = rollAttack(item('2d6'), {
      modifierSources: [], abilityScores: scores(), proficiencyBonus: 2, classes: [], rollDie, manualDamageDice: 1
    });
    expect(calls.filter((sides) => sides === 6)).toHaveLength(3);
    expect(result.damage[0]).toBe('+1 damage die (manual): 2d6 -> 3d6');
    expect(result.manualDamageDice).toBe(1);
    expect(result.attackPool.size).toBe(1);
  });

  it('passes the choices defaults through unchanged', () => {
    expect(defaultRollChoices()).toEqual({ disabledSourceIds: [], situationalAdvantage: 0, situationalDisadvantage: 0, manualDamageDice: 0 });
  });
});

describe('rollManualAttack', () => {
  it('takes target sources and the damage delta', () => {
    const target = collectAdvantageSources([effect('dodge', 'Dodge', [{ target: 'attacks_against.all', type: 'disadvantage' }])], ['attacks_against.weapon'], {}, 'target');
    const result = rollManualAttack({ name: 'Bite', toHitBonus: 4, damageRolls: '1d8', damageBonus: 2 }, scripted([15, 3, 4]).rollDie, {
      extraAdvantageSources: target, manualDamageDice: 1
    });
    expect(result.attackPool.size).toBe(2);
    expect(result.attackPool.direction).toBe('lowest');
    expect(result.manualDamageDice).toBe(1);
  });
});

describe('mergeDiceTerms', () => {
  it('combines like dice', () => {
    expect(mergeDiceTerms('1d10 + 1d10')).toBe('2d10');
    expect(mergeDiceTerms('2d6 + 1d4 + 2d6 + 3')).toBe('4d6 + 1d4 + 3');
  });
  it('leaves flat-only and empty input unchanged', () => {
    expect(mergeDiceTerms('5')).toBe('5');
    expect(mergeDiceTerms('')).toBe('');
  });
  it('is used by the manual dice audit line', () => {
    expect(adjustPrimaryDamageDice('1d10 + 1d10', 1).auditLine).toBe('+1 damage die (manual): 2d10 -> 3d10');
  });
});

describe('resolveSpellDamage scaling display', () => {
  const fireBolt = { name: 'Fire Bolt', spellLevel: 0, resolutionType: 'attack' as const, damageType: 'fire', baseDice: '1d10',
    saveAbility: 'dex' as const, saveEffect: 'half' as const, scaling: { kind: 'cantrip' as const, extraDice: '1d10', tiers: [5, 11, 17] } };
  it('merges cantrip scaling and notes the level', () => {
    const profile = resolveSpellDamage(fireBolt, { castAtSlotLevel: 0, casterLevel: 6, modifierSources: [] });
    expect(profile.diceExpression).toBe('2d10');
    expect(profile.scalingNote).toBe('cantrip, level 6');
  });
  it('has no note when nothing scaled', () => {
    const profile = resolveSpellDamage(fireBolt, { castAtSlotLevel: 0, casterLevel: 3, modifierSources: [] });
    expect(profile.diceExpression).toBe('1d10');
    expect(profile.scalingNote).toBeUndefined();
  });
  it('notes an upcast', () => {
    const burning = { name: 'Burning Hands', spellLevel: 1, resolutionType: 'save' as const, damageType: 'fire', baseDice: '3d6',
      saveAbility: 'dex' as const, saveEffect: 'half' as const, scaling: { kind: 'leveled' as const, extraDicePerSlotLevel: '1d6' } };
    const profile = resolveSpellDamage(burning, { castAtSlotLevel: 3, casterLevel: 5, modifierSources: [] });
    expect(profile.diceExpression).toBe('5d6');
    expect(profile.scalingNote).toBe('cast at level 3');
  });
});

describe('spellAttackCandidates', () => {
  it('matches attack_roll.all and spell attack modifiers, but not weapon ones', () => {
    const generic = effect('a', 'Generic', [{ target: 'attack_roll.all', type: 'advantage' }]);
    const spellOnly = effect('b', 'Spell sight', [{ target: 'attack_roll.spell', type: 'advantage' }]);
    const weaponOnly = effect('c', 'Weapon grip', [{ target: 'attack_roll.weapon', type: 'advantage' }]);
    const sources = collectAdvantageSources([generic, spellOnly, weaponOnly], spellAttackCandidates, {}, 'attacker');
    expect(sources.map((source) => source.label).sort()).toEqual(['Generic', 'Spell sight']);
  });
});

describe('homebrew crit rule: max of the primary dice added once', () => {
  it('1d8 crit is the roll plus 8', () => {
    const result = rollDamage('1d8', 0, 0, '', [], [], scripted([3]).rollDie, true);
    expect(result.total).toBe(3 + 8);
    expect(result.lines).toContain('Crit (homebrew max dice): +8 (1d8 max) = 11');
  });

  it('2d8 + 1d4 + 4 crit maximises only the primary 2d8 (+16), not the secondary 1d4', () => {
    const result = rollDamage('2d8 + 1d4 + 4', 0, 0, '', [], [], scripted([2, 5, 3]).rollDie, true);
    expect(result.total).toBe(2 + 5 + 3 + 4 + 16);
    expect(result.lines.some((line) => line.startsWith('Crit (homebrew max dice): +16 (2d8 max)'))).toBe(true);
  });

  it('treats repeated primary terms (scaled cantrip) as one merged primary', () => {
    const result = rollDamage('1d10 + 1d10', 0, 0, '', [], [], scripted([4, 6]).rollDie, true);
    expect(result.total).toBe(4 + 6 + 20);
  });

  it('does not maximise extra-die modifier dice such as sneak attack', () => {
    const extra = [{ label: 'Sneak Attack', expression: '1d6', rolls: [4], value: 4 }];
    const result = rollDamage('1d8', 0, 0, '', [], extra, scripted([3]).rollDie, true);
    expect(result.total).toBe(3 + 4 + 8);
  });

  it('gives no bonus on a non-crit, and never maximises flat bonuses', () => {
    const plain = rollDamage('1d8', 2, 0, '', [], [], scripted([3]).rollDie, false);
    expect(plain.total).toBe(5);
    expect(plain.lines.some((line) => line.startsWith('Crit'))).toBe(false);
    expect(rollDamage('4', 0, 0, '', [], [], undefined, true).total).toBe(4);
  });

  it('maximises the adjusted dice count when a manual die is added', () => {
    // natural 20, then three d6 (2d6 +1) all rolling 1: 3 + str mod 2 + 3d6 max 18
    const result = rollAttack(item('2d6'), {
      modifierSources: [], abilityScores: scores(), proficiencyBonus: 2, classes: [], rollDie: scripted([20, 1, 1, 1]).rollDie, manualDamageDice: 1
    });
    expect(result.outcomes).toContain('critical_hit');
    expect(result.damageTotal).toBe(3 + 2 + 18);
  });

  it('does not crit a manual save/auto spell from its discarded d20', () => {
    const result = rollManualAttack({ name: 'Burst', toHitBonus: 0, damageRolls: '1d8', damageBonus: 0 }, scripted([20, 3]).rollDie, { allowCrit: false });
    expect(result.damageTotal).toBe(3);
  });
});

describe('appliedEffectRowIds', () => {
  const uuid = '3f2b8a52-1c4d-4e6f-9a7b-0123456789ab';
  const src = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: 'x', kind: 'advantage' as const, origin: 'attacker' as const, applied: true, ...extra });
  it('returns the applied attacker-side effect row ids only', () => {
    const ids = appliedEffectRowIds([
      src(`attacker|effect:${uuid}|attack_roll.all|advantage|0`),
      src(`attacker|effect:${uuid}|attack_roll.all|advantage|1`), // same row twice: once
      src('attacker|effect:11111111-1111-4111-8111-111111111111|a|b|0', { applied: false }), // unticked
      src('target|effect:22222222-2222-4222-8222-222222222222|a|b|0', { origin: 'target' }),
      src('attacker|item:33333333-3333-4333-8333-333333333333|a|b|0'),
      src('situational|advantage|1', { origin: 'situational' })
    ]);
    expect(ids).toEqual([uuid]);
  });
});
