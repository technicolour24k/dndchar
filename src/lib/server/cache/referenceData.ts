// db-traffic-reduction Phase 2: a tiny in-memory cache for shared, admin-edited-only
// reference data (effect/condition definitions, item categories, and later
// Phase 3's catalogue index) - never per-character state. Single Node process,
// small trusted group, so a plain module-level Map is enough; no need for a
// shared cache service or an external store.
//
// Stores the *promise*, not the resolved value, so concurrent callers loading
// the same key while the query is still in flight share one DB round trip
// instead of firing it once per caller (see cachedReference below).

type CacheEntry = { promise: Promise<unknown>; expiresAt: number };

const cache = new Map<string, CacheEntry>();

// Safety net for content changed outside the app (scripts, manual SQL) that
// can't call invalidateReferenceData themselves. In-app writes invalidate
// immediately (see the write functions in catalogue.ts, content-admin.ts,
// rules-admin.ts and modifier-admin.ts), so this TTL is a backstop, not the
// primary invalidation path.
const defaultTtlMs = 10 * 60 * 1000;

export async function cachedReference<T>(
  key: string,
  load: () => Promise<T>,
  options: { ttlMs?: number } = {}
): Promise<T> {
  const ttlMs = options.ttlMs ?? defaultTtlMs;
  const now = Date.now();

  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) return existing.promise as Promise<T>;

  const promise = load().catch((error) => {
    // A transient DB error shouldn't be remembered as "the answer" for the
    // rest of the TTL - only remove the entry if it's still the one we just
    // set (a concurrent invalidate + reload could already have replaced it).
    if (cache.get(key)?.promise === promise) cache.delete(key);
    throw error;
  });

  cache.set(key, { promise, expiresAt: now + ttlMs });
  return promise;
}

// Admin writes call this after every content/modifier/effect/rule-hook
// change (see the write functions listed above) so the next read reflects
// the edit immediately rather than waiting out the TTL. One global clear -
// admin writes are rare, and per-key invalidation isn't worth the added
// bookkeeping at this scale.
export function invalidateReferenceData(reason: string): void {
  cache.clear();
  console.info(`[cache] reference data invalidated: ${reason}`);
}
