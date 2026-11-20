// db-traffic-reduction Phase 3: hand-written fuzzy matching over the in-memory catalogue
// index (see src/lib/server/services/catalogue.ts's getCatalogueIndex()). Pure module - no
// $lib/server or $env imports - so it's unit-testable in isolation and could be reused from a
// plain tsx script later. No library: the index is small (about 1-2k rows), a linear scan is
// well under 5ms, and the scoring rules below are simple enough not to need one.

import type { ContentType } from '$lib/types/content';

/** One row of the in-memory catalogue index, precomputed once per refresh (24h TTL, or sooner
 * on an in-app content write, or the admin "Reload catalogue" button - see catalogue.ts). */
export type CatalogueIndexEntry = {
  id: string;
  type: ContentType;
  name: string;
  sourceKind: 'srd' | 'homebrew';
  spellLevel: number | null;
  /** normaliseText(name), precomputed so a search doesn't redo it on every row every keystroke. */
  normalisedName: string;
  /** normalisedName.split(' '), precomputed for the word-prefix/substring/typo checks below. */
  words: string[];
};

export type CatalogueSearchOptions = {
  type?: ContentType;
  limit?: number;
};

const DEFAULT_LIMIT = 20;

/** Lowercases, strips accents (NFD + combining marks), and collapses anything that isn't a
 * letter or digit into single spaces. Used for both index entries (precomputed once) and the
 * search query (computed per call) so the two sides compare like for like. */
export function normaliseText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Builds the precomputed fields for one catalogue row - called once per row whenever the
 * index refreshes, not per search. */
export function buildIndexEntry(row: Omit<CatalogueIndexEntry, 'normalisedName' | 'words'>): CatalogueIndexEntry {
  const normalisedName = normaliseText(row.name);
  return { ...row, normalisedName, words: normalisedName.split(' ').filter(Boolean) };
}

/** Plain (non-Damerau) Levenshtein edit distance. Good enough for the typo tolerance below -
 * an adjacent-letter swap costs 2 here, not 1, but the 8+-char threshold is 2 anyway. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previousRow = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const currentRow = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitutionCost = a[i - 1] === b[j - 1] ? 0 : 1;
      currentRow[j] = Math.min(
        currentRow[j - 1] + 1, // insertion
        previousRow[j] + 1, // deletion
        previousRow[j - 1] + substitutionCost // substitution
      );
    }
    previousRow = currentRow;
  }
  return previousRow[b.length];
}

/** True if every character of `needle` appears in `haystack` in order (not necessarily
 * contiguous) - the loosest, lowest-scored match below ("in-order subsequence"). */
function isSubsequence(needle: string, haystack: string): boolean {
  if (!needle.length) return true;
  let index = 0;
  for (const char of haystack) {
    if (char === needle[index]) index += 1;
    if (index === needle.length) return true;
  }
  return false;
}

/** One-typo tolerance widens with query length so short queries don't match half the
 * catalogue: no tolerance under 4 characters, at most 1 edit for 4-7, at most 2 for 8+. */
function typoDistanceFor(queryLength: number): number {
  if (queryLength >= 8) return 2;
  if (queryLength >= 4) return 1;
  return 0;
}

/** Scores one entry against an already-normalised query. Keeps the *best* matching rule per
 * entry rather than summing them - see Phase 3 of db-traffic-reduction.md for the exact scale. */
function scoreEntry(entry: CatalogueIndexEntry, normalisedQuery: string, queryTokens: string[]): number {
  let score = 0;
  if (entry.normalisedName === normalisedQuery) score = Math.max(score, 100);
  if (entry.normalisedName.startsWith(normalisedQuery)) score = Math.max(score, 80);
  if (entry.words.some((word) => word.startsWith(normalisedQuery))) score = Math.max(score, 60);
  if (entry.normalisedName.includes(normalisedQuery)) score = Math.max(score, 40);
  if (queryTokens.length && queryTokens.every((token) => entry.words.some((word) => word.includes(token)))) {
    score = Math.max(score, 30);
  }
  const typoDistance = typoDistanceFor(normalisedQuery.length);
  if (typoDistance > 0 && entry.words.some((word) => levenshtein(word, normalisedQuery) <= typoDistance)) {
    score = Math.max(score, 20);
  }
  if (isSubsequence(normalisedQuery, entry.normalisedName)) score = Math.max(score, 10);
  return score;
}

function compareByScoreThenName(scoreA: number, scoreB: number, nameA: string, nameB: string): number {
  if (scoreA !== scoreB) return scoreB - scoreA;
  if (nameA.length !== nameB.length) return nameA.length - nameB.length;
  return nameA.localeCompare(nameB);
}

/**
 * Searches the in-memory catalogue index for the top `limit` matches (default 20). An empty
 * query returns the first `limit` entries of the given type alphabetically, so a picker is
 * browsable on focus before the user types anything.
 */
export function searchCatalogue(
  entries: CatalogueIndexEntry[],
  query: string,
  options: CatalogueSearchOptions = {}
): CatalogueIndexEntry[] {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const typed = options.type ? entries.filter((entry) => entry.type === options.type) : entries;

  const normalisedQuery = normaliseText(query);
  if (!normalisedQuery) {
    return [...typed].sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
  }

  const queryTokens = normalisedQuery.split(' ').filter(Boolean);
  const scored = typed
    .map((entry) => ({ entry, score: scoreEntry(entry, normalisedQuery, queryTokens) }))
    .filter(({ score }) => score > 0);

  scored.sort((a, b) => compareByScoreThenName(a.score, b.score, a.entry.name, b.entry.name));
  return scored.slice(0, limit).map(({ entry }) => entry);
}
