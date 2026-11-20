import { fail, redirect } from '@sveltejs/kit';
import { loginWithPassword, setSessionCookie } from '$lib/server/auth/session';
import { nextQuery, safeNext } from '$lib/server/auth/safeNext';
import { isRegistrationEnabled } from '$lib/server/services/app-settings';

export async function load({ url }) {
  return {
    next: safeNext(url.searchParams.get('next')),
    nextQuery: nextQuery(safeNext(url.searchParams.get('next'))),
    registrationEnabled: await isRegistrationEnabled()
  };
}

export const actions = {
  default: async ({ request, cookies, url }) => {
    const form = await request.formData();
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');
    // Hidden field first, then the URL (the form posts back to ?next=...); validated either way.
    const next = safeNext(String(form.get('next') || url.searchParams.get('next') || ''));

    if (!email || !password) {
      return fail(400, { error: 'Email and password are required.', email });
    }

    const token = await loginWithPassword(email, password);
    if (!token) {
      return fail(401, { error: 'Invalid email or password.', email });
    }

    setSessionCookie(cookies, token);
    throw redirect(303, next);
  }
};
