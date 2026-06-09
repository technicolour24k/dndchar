import { fail, redirect } from '@sveltejs/kit';
import { loginWithPassword, setSessionCookie } from '$lib/server/auth/session';
import { isRegistrationEnabled } from '$lib/server/services/app-settings';

export async function load() {
  return {
    registrationEnabled: await isRegistrationEnabled()
  };
}

export const actions = {
  default: async ({ request, cookies }) => {
    const form = await request.formData();
    const email = String(form.get('email') || '').trim();
    const password = String(form.get('password') || '');

    if (!email || !password) {
      return fail(400, { error: 'Email and password are required.', email });
    }

    const token = await loginWithPassword(email, password);
    if (!token) {
      return fail(401, { error: 'Invalid email or password.', email });
    }

    setSessionCookie(cookies, token);
    throw redirect(303, '/dashboard');
  }
};
