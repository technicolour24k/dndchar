import { describe, expect, it } from 'vitest';
import { buildIndexEntry, normaliseText, searchCatalogue, type CatalogueIndexEntry } from './fuzzySearch';

function entry(name: string, overrides: Partial<Omit<CatalogueIndexEntry, 'normalisedName' | 'words' | 'name'>> = {}): CatalogueIndexEntry {
  return buildIndexEntry({
    id: overrides.id ?? name,
    type: overrides.type ?? 'spell',
    name,
    sourceKind: overrides.sourceKind ?? 'srd',
    spellLevel: overrides.spellLevel ?? null
  });
}

describe('normaliseText', () => {
  it('lowercases, strips accents and collapses punctuation to single spaces', () => {
    expect(normaliseText('Café Résumé!!')).toBe('cafe resume');
    expect(normaliseText("Melf's Acid Arrow")).toBe('melf s acid arrow');
    expect(normaliseText('  Fireball  ')).toBe('fireball');
  });
});

describe('searchCatalogue', () => {
  const fireball = entry('Fireball', { id: 'fireball', spellLevel: 3 });
  const fireBolt = entry('Fire Bolt', { id: 'fire-bolt', spellLevel: 0 });
  const produceFlame = entry('Produce Flame', { id: 'produce-flame', spellLevel: 0 });
  const magicMissile = entry('Magic Missile', { id: 'magic-missile', spellLevel: 1 });
  const flameCafe = entry('Café Flambé', { id: 'cafe-flambe', spellLevel: 0 });
  const basicEntries = [fireball, fireBolt, produceFlame, magicMissile, flameCafe];

  it('gives an exact name match the top score', () => {
    const results = searchCatalogue(basicEntries, 'Fireball');
    expect(results[0].id).toBe('fireball');
  });

  it('matches a name that starts with the query (prefix)', () => {
    const results = searchCatalogue(basicEntries, 'fire');
    // Both "Fireball" and "Fire Bolt" start with "fire" - both should be returned, ahead of
    // "Produce Flame" which only contains "fire"-adjacent letters via word-prefix, not a name prefix.
    expect(results.map((r) => r.id)).toEqual(expect.arrayContaining(['fireball', 'fire-bolt']));
    expect(results[0].name.toLowerCase().startsWith('fire')).toBe(true);
  });

  it('matches a word-prefix even when the name itself does not start with the query', () => {
    const results = searchCatalogue(basicEntries, 'flame');
    // "Produce Flame" doesn't start with "flame", but its second word does.
    expect(results.map((r) => r.id)).toContain('produce-flame');
  });

  it('matches every query token against some word, in any order (multi-word)', () => {
    const results = searchCatalogue(basicEntries, 'flame produce');
    expect(results.map((r) => r.id)).toContain('produce-flame');
  });

  it('tolerates a single typo on longer queries', () => {
    // "fierball" is a two-substitution typo of "fireball" - within the 8+-char budget of 2.
    const results = searchCatalogue(basicEntries, 'fierball');
    expect(results.map((r) => r.id)).toContain('fireball');
  });

  it('does not tolerate typos on short queries (under 4 chars)', () => {
    // "fyr" is a 1-edit typo of "fire", but at 3 characters it's below the 4-char threshold
    // where typo tolerance kicks in, so it should not surface "Fire Bolt"/"Fireball".
    const results = searchCatalogue(basicEntries, 'fyr');
    expect(results.find((r) => r.id === 'fireball' || r.id === 'fire-bolt')).toBeUndefined();
  });

  it('normalises accents so the query and the entry compare equal', () => {
    const results = searchCatalogue(basicEntries, 'cafe flambe');
    expect(results.map((r) => r.id)).toContain('cafe-flambe');
  });

  it('filters by type', () => {
    const item = entry('Fire Sword', { id: 'fire-sword', type: 'item' });
    const entries = [...basicEntries, item];
    const spellResults = searchCatalogue(entries, 'fire', { type: 'spell' });
    const itemResults = searchCatalogue(entries, 'fire', { type: 'item' });
    expect(spellResults.map((r) => r.id)).not.toContain('fire-sword');
    expect(itemResults.map((r) => r.id)).toEqual(['fire-sword']);
  });

  it('caps results at the given limit (default 20)', () => {
    const many = Array.from({ length: 30 }, (_, index) => entry(`Test Spell ${index}`, { id: `test-${index}` }));
    expect(searchCatalogue(many, 'test')).toHaveLength(20);
    expect(searchCatalogue(many, 'test', { limit: 5 })).toHaveLength(5);
  });

  it('returns the first entries alphabetically for an empty query, so the picker is browsable on focus', () => {
    const results = searchCatalogue(basicEntries, '', { limit: 3 });
    const names = results.map((r) => r.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
    expect(results).toHaveLength(3);
  });

  it('drops entries that score zero rather than returning the whole index', () => {
    const results = searchCatalogue(basicEntries, 'zzz-no-match-zzz');
    expect(results).toHaveLength(0);
  });
});
