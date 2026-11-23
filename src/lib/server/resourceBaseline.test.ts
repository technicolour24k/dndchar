import { describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));
vi.mock('$lib/server/services/catalogue', () => ({}));
vi.mock('$lib/server/services/rule-engine', () => ({}));
vi.mock('$lib/server/services/effects', () => ({}));
vi.mock('$lib/server/services/encounters', () => ({}));
vi.mock('$lib/server/services/combatLog', () => ({}));
vi.mock('$lib/server/cache/referenceData', () => ({ cachedReference: vi.fn() }));

const { keepUneditedResources, keepUneditedCoins } = await import('./services/characters');

// Decks unit 6: the sheet Save writes only HP, temp HP and coin the user actually edited.
const res = (hp: number, temp: number) => [
  { key: 'hp', label: 'HP', currentValue: hp, maxValue: 30 },
  { key: 'temp_hp', label: 'Temp HP', currentValue: temp, maxValue: temp }
];
const baseline = { hp: 20, tempHp: 4, coins: { currencyGp: '10', currencyCp: '' } };

describe('keepUneditedResources', () => {
  it('keeps the database value for an HP and temp HP equal to the baseline', () => {
    const rows = res(20, 4);
    keepUneditedResources(rows, baseline, { hp: 12, tempHp: 11 });
    expect(rows[0].currentValue).toBe(12);
    expect(rows[1]).toMatchObject({ currentValue: 11, maxValue: 11 });
  });
  it('writes a value the user edited, and leaves the other one alone', () => {
    const rows = res(25, 4);
    keepUneditedResources(rows, baseline, { hp: 12, tempHp: 11 });
    expect(rows[0].currentValue).toBe(25);
    expect(rows[1].currentValue).toBe(11);
  });
  it('keeps the posted value when there is no database row, or no baseline for it', () => {
    const rows = res(20, 4);
    keepUneditedResources(rows, baseline, { hp: null, tempHp: null });
    expect(rows.map((r) => r.currentValue)).toEqual([20, 4]);
    keepUneditedResources(rows, { coins: {} }, { hp: 1, tempHp: 1 });
    expect(rows.map((r) => r.currentValue)).toEqual([20, 4]);
  });
});

describe('keepUneditedCoins', () => {
  it('drops unedited coin fields from the patch and keeps edited ones', () => {
    const patch: Record<string, unknown> = { currencyGp: '10', currencyCp: '', currencySp: '7', race: 'Elf' };
    keepUneditedCoins(patch, baseline);
    expect(patch).toEqual({ currencySp: '7', race: 'Elf' });
    const edited: Record<string, unknown> = { currencyGp: '15' };
    keepUneditedCoins(edited, baseline);
    expect(edited).toEqual({ currencyGp: '15' });
  });
});
