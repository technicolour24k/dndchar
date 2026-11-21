import { describe, expect, it } from 'vitest';
import { normaliseDamageType, resolveDamageTaken } from './damageTaken';

// A minimal effect/container with the given damage_taken modifiers.
function source(name: string, modifiers: Array<[string, string, string?, string?]>, effectKey = name.toLowerCase().replace(/\s+/g, '_')): any {
  return {
    id: effectKey, effectId: effectKey, effectKey, name, modifiers: modifiers.map(([target, modifierType, valueExpression = '', conditionExpression = '']) => ({
      target, modifierType, valueExpression, conditionExpression, priority: 0
    }))
  };
}
const armour = (value = '2', condition = '') => source('Plate', [['damage_taken.all', 'penalty', value, condition]]);
const rage = () => source('Rage', ['bludgeoning', 'piercing', 'slashing'].map((t) => [`damage_taken.${t}`, 'resistance'] as [string, string]));

describe('resolveDamageTaken', () => {
  it('leaves damage alone with no modifiers', () => {
    const result = resolveDamageTaken([], { amount: 7, damageType: 'slashing' });
    expect(result.final).toBe(7);
    expect(result.steps).toEqual([]);
    expect(result.breakdown).toBe('');
  });

  it('applies a flat reduction with a source-attributed line', () => {
    const result = resolveDamageTaken([armour()], { amount: 7, damageType: 'slashing' });
    expect(result.final).toBe(5);
    expect(result.breakdown).toBe('7 - 2 (Plate) = 5');
  });

  it('adds extra damage taken from a bonus', () => {
    const cursed = source('Cursed', [['damage_taken.all', 'bonus', '3']]);
    expect(resolveDamageTaken([cursed], { amount: 4 }).final).toBe(7);
  });

  it('floors a flat reduction at 0', () => {
    const result = resolveDamageTaken([armour('5')], { amount: 3, damageType: 'fire' });
    expect(result.final).toBe(0);
    expect(result.breakdown).toContain('floored at 0');
  });

  it('resistance halves, rounding down', () => {
    const result = resolveDamageTaken([rage()], { amount: 7, damageType: 'slashing' });
    expect(result.final).toBe(3);
    expect(result.breakdown).toBe('halved (Rage: resistance to slashing) = 3');
  });

  it('vulnerability doubles', () => {
    const weak = source('Brittle', [['damage_taken.fire', 'vulnerability']]);
    expect(resolveDamageTaken([weak], { amount: 6, damageType: 'Fire' }).final).toBe(12);
  });

  it('resistance and vulnerability cancel', () => {
    const weak = source('Brittle', [['damage_taken.slashing', 'vulnerability']]);
    const result = resolveDamageTaken([rage(), weak], { amount: 7, damageType: 'slashing' });
    expect(result.final).toBe(7);
    expect(result.breakdown).toContain('cancel');
  });

  it('multiple resistances do not stack', () => {
    const second = source('Ward', [['damage_taken.slashing', 'resistance'], ['damage_taken.all', 'resistance']]);
    expect(resolveDamageTaken([rage(), second], { amount: 8, damageType: 'slashing' }).final).toBe(4);
  });

  it('immunity takes everything to 0', () => {
    const immune = source('Stoneskin', [['damage_taken.poison', 'immunity']]);
    expect(resolveDamageTaken([immune, armour()], { amount: 9, damageType: 'poison' }).final).toBe(0);
  });

  it('matches typed targets only for that type, and untyped damage only matches .all', () => {
    const fire = source('Fire ward', [['damage_taken.fire', 'resistance']]);
    expect(resolveDamageTaken([fire], { amount: 8, damageType: 'fire' }).final).toBe(4);
    expect(resolveDamageTaken([fire], { amount: 8, damageType: 'cold' }).final).toBe(8);
    expect(resolveDamageTaken([fire], { amount: 8 }).final).toBe(8);
    expect(resolveDamageTaken([rage()], { amount: 8, damageType: null }).final).toBe(8);
    const all = source('Ward', [['damage_taken.all', 'resistance']]);
    expect(resolveDamageTaken([all], { amount: 8 }).final).toBe(4);
    expect(resolveDamageTaken([all], { amount: 8, damageType: 'acid' }).final).toBe(4);
  });

  it('a flag-gated reduction only applies with the flag effect present', () => {
    const plate = armour('2', 'flag:half_cover');
    const cover = source('Half Cover', []);
    expect(resolveDamageTaken([plate], { amount: 7 }).final).toBe(7);
    const covered = resolveDamageTaken([plate, cover], { amount: 7 });
    expect(covered.final).toBe(5);
    expect(covered.breakdown).toBe('7 - 2 (Plate) = 5');
  });

  it('reduces flat before halving (7 - 2 = 5, halved = 2)', () => {
    const result = resolveDamageTaken([armour(), rage()], { amount: 7, damageType: 'slashing' });
    expect(result.final).toBe(2);
    expect(result.steps.map((step) => step.after)).toEqual([5, 2]);
  });

  it('ignores zero or junk amounts', () => {
    expect(resolveDamageTaken([armour()], { amount: 0 }).final).toBe(0);
    expect(resolveDamageTaken([armour()], { amount: Number.NaN }).final).toBe(0);
  });

  it('normalises damage types', () => {
    expect(normaliseDamageType(' Fire ')).toBe('fire');
    expect(normaliseDamageType('')).toBeNull();
    expect(normaliseDamageType(undefined)).toBeNull();
  });
});

describe('resolveDamageTaken wording', () => {
  it('names "all damage" when the modifier came from damage_taken.all', () => {
    const all = source('Ward', [['damage_taken.all', 'resistance']]);
    expect(resolveDamageTaken([all], { amount: 8, damageType: 'slashing' }).breakdown).toBe('halved (Ward: resistance to all damage) = 4');
  });
});
