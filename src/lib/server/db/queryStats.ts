import { AsyncLocalStorage } from 'node:async_hooks';
import { env } from '$env/dynamic/private';

// Phase 0 of db-traffic-reduction: cheap, off-by-default instrumentation to
// measure how many queries/rows/bytes each request actually costs, so later
// phases (caching, slimmer loads, push instead of poll) have a real baseline
// to compare against instead of guessing. Zero overhead when DB_QUERY_STATS
// isn't set to '1' - every call site below checks statsEnabled() first.

export type QueryStats = { queries: number; rows: number; bytes: number };

// Per-request accumulator. hooks.server.ts opens one of these per request (when
// enabled) via queryStatsStorage.run(...), so db/index.ts's query() and
// withTransaction() can attribute cost back to the request that caused it
// without threading a stats object through every service function signature.
export const queryStatsStorage = new AsyncLocalStorage<QueryStats>();

// Running total since the last periodic summary. Separate from the per-request
// stats above because it needs to survive across requests (and outlive any
// single ALS scope) for the "last 60s" log line.
const rollingStats: QueryStats = { queries: 0, rows: 0, bytes: 0 };

export function statsEnabled(): boolean {
  return env.DB_QUERY_STATS === '1';
}

// Bytes are approximate: Buffer.byteLength(JSON.stringify(rows)) is a proxy
// for wire size, not the actual pg wire protocol (which differs by column
// count/type and text vs binary mode). Good enough to compare "before" and
// "after" a change, which is all Phase 0 needs - not an exact egress figure.
export function recordQuery(result: { rows?: unknown[] } | null | undefined): void {
  if (!statsEnabled()) return;

  const rows = result?.rows ?? [];
  const bytes = Buffer.byteLength(JSON.stringify(rows));

  rollingStats.queries += 1;
  rollingStats.rows += rows.length;
  rollingStats.bytes += bytes;

  const requestStats = queryStatsStorage.getStore();
  if (requestStats) {
    requestStats.queries += 1;
    requestStats.rows += rows.length;
    requestStats.bytes += bytes;
  }
}

// Logs "[db] last 60s: N queries, R rows, ~X KB" every 60s, even when
// nothing happened - a zero line proves the app is idle rather than the
// logger being broken. Guarded by a globalThis flag so Vite's dev-mode HMR
// re-running this module (or hooks.server.ts re-importing it) doesn't stack
// up duplicate intervals.
export function startPeriodicSummary(): void {
  const g = globalThis as typeof globalThis & { __dbQueryStatsSummaryStarted__?: boolean };
  if (g.__dbQueryStatsSummaryStarted__) return;
  g.__dbQueryStatsSummaryStarted__ = true;

  const timer = setInterval(() => {
    const { queries, rows, bytes } = rollingStats;
    rollingStats.queries = 0;
    rollingStats.rows = 0;
    rollingStats.bytes = 0;
    console.log(`[db] last 60s: ${queries} queries, ${rows} rows, ~${(bytes / 1024).toFixed(1)} KB`);
  }, 60_000);

  // Don't hold the process open just for this timer (matters for scripts/tests
  // that import this module transitively but never call startPeriodicSummary
  // from a long-running server).
  timer.unref?.();
}
