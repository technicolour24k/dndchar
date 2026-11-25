import { describe, expect, it } from 'vitest';
import { readEffectMetadata, substituteParams } from './effectParams';

describe('substituteParams', () => {
  it('replaces a placeholder', () => expect(substituteParams('{value}', { value: 3 })).toBe('3'));
  it('keeps a negative value', () => expect(substituteParams('{value}', { value: -3 })).toBe('-3'));
  it('a missing name or missing params becomes 0', () => {
    expect(substituteParams('{nope}', { value: 3 })).toBe('0');
    expect(substituteParams('{value}', undefined)).toBe('0');
  });
  it('leaves expressions without placeholders unchanged', () => {
    expect(substituteParams('2', { value: 9 })).toBe('2');
    expect(substituteParams('1d4', null)).toBe('1d4');
    expect(substituteParams('', {})).toBe('');
  });
  it('folds pure integer arithmetic so Number()-based evaluators get a valid value', () => {
    expect(substituteParams('2+{value}', { value: -3 })).toBe('-1');
    expect(substituteParams('2+{value}', { value: 3 })).toBe('5');
    expect(substituteParams('-{value}', { value: -3 })).toBe('3');
    expect(substituteParams('-{value}', { value: 3 })).toBe('-3');
    expect(substituteParams('{value}', { value: -3 })).toBe('-3');
    expect(substituteParams('{value} - 1', { value: 4 })).toBe('3');
  });
  it('leaves dice expressions alone', () => {
    expect(substituteParams('{n}d6', { n: 2 })).toBe('2d6');
    expect(substituteParams('1d4+{n}', { n: 2 })).toBe('1d4+2');
    expect(substituteParams('1d4', { n: 2 })).toBe('1d4');
  });
  it('ignores inherited names and non-finite values', () => {
    expect(substituteParams('{constructor}', {})).toBe('0');
    expect(substituteParams('{value}', { value: Number.NaN })).toBe('0');
  });
});

describe('readEffectMetadata', () => {
  it('reads params and label, and tolerates junk', () => {
    expect(readEffectMetadata({ params: { value: -3, bad: 'x' }, sourceLabel: '3 of Clubs, failed' }))
      .toEqual({ params: { value: -3 }, sourceLabel: '3 of Clubs, failed' });
    expect(readEffectMetadata(null)).toEqual({ params: {}, sourceLabel: '' });
    expect(readEffectMetadata({})).toEqual({ params: {}, sourceLabel: '' });
  });
});
