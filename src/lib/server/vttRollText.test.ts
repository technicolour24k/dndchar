import { describe, expect, it } from 'vitest';
// Relative import, same as vttStore.test.ts: the VTT server code lives outside src/.
import { formatAttackRollText, formatManualDamageText } from '../../../vtt/server/handlers/token.js';

const pool = (overrides: Record<string, unknown> = {}) => ({
  size: 3, net: 2, rolls: [12, 17, 5], kept: 17, manualAdvantage: 0, manualDisadvantage: 0, ...overrides
});

describe('formatAttackRollText', () => {
  it('is the old text when there is no pool', () => {
    expect(formatAttackRollText(null, 21, null)).toBe(' (21)');
    expect(formatAttackRollText('critical_miss', 4, undefined)).toBe(' (natural 1)');
    expect(formatAttackRollText(null, NaN, null)).toBe('');
  });

  it('is the old text for a plain single die with no manual points', () => {
    expect(formatAttackRollText(null, 15, pool({ size: 1, net: 0, rolls: [12], kept: 12 }))).toBe(' (15)');
  });

  it('describes an advantage pool', () => {
    expect(formatAttackRollText(null, 21, pool())).toBe(' (21: 3d20 adv x2, keeps 17)');
  });

  it('adds the manual parts', () => {
    expect(formatAttackRollText(null, 21, pool({ manualAdvantage: 1 }))).toBe(' (21: 3d20 adv x2, keeps 17; manual +1 adv)');
    expect(formatAttackRollText(null, 14, pool({ size: 1, net: 0, rolls: [10], kept: 10, manualDisadvantage: 2 }))).toBe(' (14: 1d20 flat; manual +2 dis)');
  });

  it('shows a natural 1 without the total', () => {
    expect(formatAttackRollText('critical_miss', 3, pool({ net: -2, rolls: [1, 9, 15], kept: 1 }))).toBe(' (natural 1: 3d20 dis x2, keeps 1)');
  });

  it('drops an invalid pool and falls back to the plain text', () => {
    expect(formatAttackRollText(null, 21, pool({ size: 12 }))).toBe(' (21)');
    expect(formatAttackRollText(null, 21, pool({ rolls: [12, 17] }))).toBe(' (21)');
    expect(formatAttackRollText(null, 21, pool({ kept: 3 }))).toBe(' (21)');
    expect(formatAttackRollText(null, 21, pool({ net: 1 }))).toBe(' (21)');
    expect(formatAttackRollText(null, 21, pool({ manualAdvantage: 6 }))).toBe(' (21)');
    expect(formatAttackRollText(null, 21, pool({ size: '3' }))).toBe(' (21)');
    expect(formatAttackRollText(null, 21, 'nope')).toBe(' (21)');
  });
});

describe('formatManualDamageText (INTERIM)', () => {
  it('words the delta', () => {
    expect(formatManualDamageText(1)).toBe(' (manual +1 damage die)');
    expect(formatManualDamageText(-2)).toBe(' (manual -2 damage dice)');
  });
  it('is empty for zero and anything invalid', () => {
    expect(formatManualDamageText(0)).toBe('');
    expect(formatManualDamageText(9)).toBe('');
    expect(formatManualDamageText(1.5)).toBe('');
    expect(formatManualDamageText('1' as unknown as number)).toBe('');
  });
});
