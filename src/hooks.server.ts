import { redirect, type Handle } from '@sveltejs/kit';
import { getUserForToken, readSessionCookie } from '$lib/server/auth/session';
import { requireAdmin } from '$lib/server/auth/authorization';
import type { SessionUser } from '$lib/types/auth';

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

export const handle: Handle = async ({ event, resolve }) => {
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
};
