import { redirect, type Handle } from '@sveltejs/kit';
import { getUserForToken, readSessionCookie } from '$lib/server/auth/session';
import { requireAdmin } from '$lib/server/auth/authorization';

const publicRoutes = new Set(['/login', '/register']);

export const handle: Handle = async ({ event, resolve }) => {
  const session = await getUserForToken(readSessionCookie(event.cookies));
  event.locals.user = session?.user ?? null;
  event.locals.sessionId = session?.sessionId ?? null;

  if (!event.locals.user && !publicRoutes.has(event.url.pathname) && !event.url.pathname.startsWith('/api/websocket')) {
    throw redirect(303, '/login');
  }

  if (event.locals.user && event.url.pathname === '/login') {
    throw redirect(303, '/dashboard');
  }

  if (event.url.pathname.startsWith('/admin')) requireAdmin(event.locals.user);

  return resolve(event);
};
