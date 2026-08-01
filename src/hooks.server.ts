import { redirect, type Handle } from '@sveltejs/kit';
import { getUserForToken, readSessionCookie } from '$lib/server/auth/session';
import { requireAdmin } from '$lib/server/auth/authorization';

const publicRoutes = new Set(['/login', '/register']);

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

  return resolve(event);
};
