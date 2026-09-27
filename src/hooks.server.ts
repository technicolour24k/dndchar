import { redirect, type Handle } from '@sveltejs/kit';
import { getUserForToken, readSessionCookie } from '$lib/server/auth/session';
import { requireAdmin } from '$lib/server/auth/authorization';
import type { SessionUser } from '$lib/types/auth';
import { queryStatsStorage, startPeriodicSummary, statsEnabled, type QueryStats } from '$lib/server/db/queryStats';

// Phase 0 of db-traffic-reduction (see plan doc): starts the rolling 60s
// summary log once per server start when DB_QUERY_STATS=1. Module-level so it
// runs once at import time rather than per-request; startPeriodicSummary
// itself guards against duplicate intervals from Vite's dev-mode HMR.
if (statsEnabled()) startPeriodicSummary();

const publicRoutes = new Set(['/login', '/register']);

// Same pattern profile.ts's normalizeColor enforces on write - re-checked
// here rather than trusted from the DB, because this lands directly in a
// raw HTML attribute via transformPageChunk below, not through Svelte's
// normal auto-escaping.
const hexColorPattern = /^#[0-9a-f]{6}$/i;

// Applied to <html> itself (not just the app-frame div) so :root's own
// derivations in src/styles.css (--bg, --panel, --panel-dark, etc., which
// are declared - and resolve - on :root) pick up the user's colours, and so
// the page background propagates to the whole viewport, not just the
// app-frame's box. Empty string for a logged-out page - :root's hard-coded
// defaults in styles.css take over.
function themeStyleFor(user: SessionUser | null): string {
  if (!user) return '';
  const { themeBackgroundColor, themePanelColor, themeTextColor } = user;
  const values = [themeBackgroundColor, themePanelColor, themeTextColor];
  if (!values.every((color) => hexColorPattern.test(color))) return '';
  return `--app-bg: ${themeBackgroundColor}; --app-panel: ${themePanelColor}; --app-text: ${themeTextColor};`;
}

// The original handle body, unwrapped. Split out so the stats wrapper below
// can run the session lookup (the one query every request makes) inside the
// same AsyncLocalStorage scope as everything resolve() triggers downstream.
async function handleRequest({ event, resolve }: Parameters<Handle>[0]) {
  const session = await getUserForToken(readSessionCookie(event.cookies));
  event.locals.user = session?.user ?? null;
  event.locals.sessionId = session?.sessionId ?? null;

  // /vtt/api/log's and /vtt/api/roll-log's POST sides are called
  // server-to-server from vtt/server's ws process (see those routes' own
  // comments) - they carry no session cookie, so they can't go through the
  // normal locals.user gate. They authenticate themselves via a shared-secret
  // header instead; each route's GET side (used by polling/backfill log
  // panels) checks locals.user itself since the hook no longer enforces it
  // for these paths.
  const bypassesUserAuth =
    event.url.pathname.startsWith('/api/websocket') ||
    event.url.pathname === '/vtt/api/log' ||
    event.url.pathname === '/vtt/api/roll-log';
  if (!event.locals.user && !publicRoutes.has(event.url.pathname) && !bypassesUserAuth) {
    throw redirect(303, '/login');
  }

  if (event.locals.user && event.url.pathname === '/login') {
    throw redirect(303, '/dashboard');
  }

  if (event.url.pathname.startsWith('/admin')) requireAdmin(event.locals.user);

  return resolve(event, {
    transformPageChunk: ({ html }) => html.replace('%theme.style%', themeStyleFor(event.locals.user))
  });
}

export const handle: Handle = async (input) => {
  // Off by default (DB_QUERY_STATS unset): skip the AsyncLocalStorage wrapper
  // entirely so there's no per-request overhead at all.
  if (!statsEnabled()) return handleRequest(input);

  const stats: QueryStats = { queries: 0, rows: 0, bytes: 0 };
  return queryStatsStorage.run(stats, async () => {
    const response = await handleRequest(input);
    // Only log requests that actually touched the DB - static assets, cached
    // 304s etc. would otherwise drown out the interesting lines.
    if (stats.queries > 0) {
      const kb = (stats.bytes / 1024).toFixed(1);
      console.log(
        `[db] ${input.event.request.method} ${input.event.url.pathname} -> ${response.status}: ${stats.queries}q ${stats.rows}r ~${kb}KB`
      );
    }
    return response;
  });
};
