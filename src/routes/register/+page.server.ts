import { fail, redirect } from '@sveltejs/kit';
import { registerWithPassword, setSessionCookie } from '$lib/server/auth/session';
import { nextQuery, safeNext } from '$lib/server/auth/safeNext';
import { isRegistrationEnabled } from '$lib/server/services/app-settings';

export async function load({ locals, url }) {
  const next = safeNext(url.searchParams.get('next'));
  if (locals.user) throw redirect(303, next);
  return {
    next,
    nextQuery: nextQuery(next),
    registrationEnabled: await isRegistrationEnabled()
  };
}

export const actions = {
  default: async ({ request, cookies, url }) => {
    const enabled = await isRegistrationEnabled();
    if (!enabled) return fail(403, { error: 'Registration is currently disabled.', email: '', displayName: '', registrationEnabled: false });

    const form = await request.formData();
    const next = safeNext(String(form.get('next') || url.searchParams.get('next') || ''));
    const email = String(form.get('email') || '').trim();
    const displayName = String(form.get('displayName') || '').trim();
    const password = String(form.get('password') || '');
    const confirmPassword = String(form.get('confirmPassword') || '');

    if (!email || !password) {
      return fail(400, { error: 'Email and password are required.', email, displayName, registrationEnabled: true });
    }

    if (password.length < 8) {
      return fail(400, { error: 'Password must be at least 8 characters.', email, displayName, registrationEnabled: true });
    }

    if (password !== confirmPassword) {
      return fail(400, { error: 'Passwords do not match.', email, displayName, registrationEnabled: true });
    }

    try {
      const token = await registerWithPassword(email, password, displayName || email);
      setSessionCookie(cookies, token);
    } catch {
      return fail(409, { error: 'That email address is already registered.', email, displayName, registrationEnabled: true });
    }

    throw redirect(303, next);
  }
};
