import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import { query } from '$lib/server/db';
import { buildTokenJsonPatch, sanitiseTemplatePatch, updateCreatureTemplate } from './creatureTemplates';

const queryMock = vi.mocked(query);
const form = (values: Record<string, string>) => ({ get: (key: string) => (key in values ? values[key] : null) });

beforeEach(() => queryMock.mockReset());

describe('sanitiseTemplatePatch', () => {
  it('clamps numbers to 0-999 and HP to 0-9999', () => {
    const patch = sanitiseTemplatePatch(
      form({ ac: '5000', speedFt: '-10', visionNormalFt: '1000', visionDarkFt: '60', hp: '12000', maxHp: '3000' })
    );
    expect(patch).toEqual({ ac: 999, speedFt: 0, visionNormalFt: 999, visionDarkFt: 60, stats: { hp: 9999, maxHp: 3000 } });
  });

  it('rounds decimals and ignores blank or non-numeric fields (except AC)', () => {
    const patch = sanitiseTemplatePatch(form({ speedFt: '30.6', visionNormalFt: '', visionDarkFt: 'abc', hp: ' ' }));
    expect(patch).toEqual({ speedFt: 31 });
  });

  it('turns a blank AC into null (unknown) but ignores a junk AC', () => {
    expect(sanitiseTemplatePatch(form({ ac: '' })).ac).toBeNull();
    expect('ac' in sanitiseTemplatePatch(form({ ac: 'x' }))).toBe(false);
  });

  it('drops unknown fields', () => {
    const patch = sanitiseTemplatePatch(form({ type: 'ally', imageUrl: 'http://x', actions: '[]', id: 'nope', ac: '12' }));
    expect(patch).toEqual({ ac: 12 });
  });

  it('trims and caps the name, and skips an empty one', () => {
    expect(sanitiseTemplatePatch(form({ name: '  Goblin  ' })).name).toBe('Goblin');
    expect(sanitiseTemplatePatch(form({ name: 'x'.repeat(200) })).name).toHaveLength(80);
    expect('name' in sanitiseTemplatePatch(form({ name: '   ' }))).toBe(false);
  });

  it('only includes the stats keys that were sent', () => {
    expect(sanitiseTemplatePatch(form({ hp: '7' })).stats).toEqual({ hp: 7 });
  });
});

describe('buildTokenJsonPatch', () => {
  it('caps HP at max HP, against the stored max too', () => {
    expect(buildTokenJsonPatch({ stats: { hp: 5, maxHp: 10 } }, { stats: { hp: 50 } })).toEqual({ stats: { hp: 10, maxHp: 10 } });
    expect(buildTokenJsonPatch({ stats: { hp: 10, maxHp: 10 } }, { stats: { maxHp: 4 } })).toEqual({ stats: { hp: 4, maxHp: 4 } });
    expect(buildTokenJsonPatch({}, { stats: { hp: 3, maxHp: 8 } })).toEqual({ stats: { hp: 3, maxHp: 8 } });
  });

  it('keeps existing stats keys when only one is patched', () => {
    const out = buildTokenJsonPatch({ stats: { hp: 5, maxHp: 10, temp: 2 } }, { stats: { hp: 8 }, name: 'Renamed' });
    expect(out).toEqual({ stats: { hp: 8, maxHp: 10, temp: 2 } });
  });

  it('copes with missing stats and never carries the name into token_json', () => {
    expect(buildTokenJsonPatch({}, { stats: { maxHp: 4 }, name: 'x', ac: null })).toEqual({ ac: null, stats: { maxHp: 4 } });
  });
});

describe('updateCreatureTemplate', () => {
  it('returns false and writes nothing when the template is not the callers', async () => {
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never);
    expect(await updateCreatureTemplate('u1', 'id1', { ac: 10 })).toBe(false);
    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(queryMock.mock.calls[0][1]).toEqual(['id1', 'u1']);
  });

  it('merges stats then updates, scoped by owner', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ token_json: { stats: { hp: 1, maxHp: 9 } } }], rowCount: 1 } as never);
    queryMock.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never);
    expect(await updateCreatureTemplate('u1', 'id1', { name: 'New', stats: { hp: 3 } })).toBe(true);
    const [sql, params] = queryMock.mock.calls[1];
    expect(sql).toContain('owner_user_id = $2');
    expect(params).toEqual(['id1', 'u1', 'New', JSON.stringify({ stats: { hp: 3, maxHp: 9 } })]);
  });
});
