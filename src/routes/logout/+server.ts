import { redirect } from '@sveltejs/kit';
import { clearSessionCookie, deleteSession } from '$lib/server/auth/session';

export async function POST({ locals, cookies }) {
  await deleteSession(locals.sessionId);
  clearSessionCookie(cookies);
  throw redirect(303, '/login');
}
