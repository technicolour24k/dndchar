import { beforeEach, describe, expect, it, vi } from 'vitest';

// Only $lib/server/db is mocked - see session.test.ts for the same pattern. withTransaction is
// stubbed too since catalogue.ts imports it, even though getCatalogueIndex() never calls it.
vi.mock('$lib/server/db', () => ({ query: vi.fn(), withTransaction: vi.fn() }));

import { query } from '$lib/server/db';
import { getCatalogueIndex } from './catalogue';
import { invalidateReferenceData } from '$lib/server/cache/referenceData';

const queryMock = vi.mocked(query);

function dbRow(overrides: Partial<{
  id: string;
  content_type: string;
  name: string;
  source_kind: string;
  spell_level: number | null;
}> = {}) {
  return {
    id: overrides.id ?? 'content-1',
    content_type: overrides.content_type ?? 'spell',
    name: overrides.name ?? 'Fireball',
    source_kind: overrides.source_kind ?? 'srd',
    spell_level: overrides.spell_level ?? 3
  };
}

beforeEach(() => {
  queryMock.mockReset();
  // The reference-data cache is a module-level singleton shared by every key (Phase 2's
  // design) - clear it so one test's cached index can't leak into the next.
  invalidateReferenceData('test setup');
});

describe('getCatalogueIndex', () => {
  it('runs one query and precomputes the normalised name/words per row', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow()] } as any);

    const index = await getCatalogueIndex();

    expect(queryMock).toHaveBeenCalledTimes(1);
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      id: 'content-1',
      type: 'spell',
      name: 'Fireball',
      sourceKind: 'srd',
      spellLevel: 3,
      normalisedName: 'fireball',
      words: ['fireball']
    });
  });

  it('serves repeat calls from cache with no further query', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow()] } as any);

    await getCatalogueIndex();
    await getCatalogueIndex();
    await getCatalogueIndex();

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it('reloads after invalidateReferenceData - the hook every write path calls', async () => {
    queryMock.mockResolvedValueOnce({ rows: [dbRow({ name: 'Fireball' })] } as any);
    const before = await getCatalogueIndex();
    expect(before[0].name).toBe('Fireball');

    // Simulates any in-app admin write (createAdminContent, saveEffect, ...) or the admin
    // "Reload catalogue" button - both call this same function.
    invalidateReferenceData('admin reload button');

    queryMock.mockResolvedValueOnce({ rows: [dbRow({ id: 'content-2', name: 'Ice Storm' })] } as any);
    const after = await getCatalogueIndex();

    expect(queryMock).toHaveBeenCalledTimes(2);
    expect(after[0].name).toBe('Ice Storm');
  });
});
