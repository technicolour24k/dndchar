import { fail } from '@sveltejs/kit';
import { isRegistrationEnabled, setRegistrationEnabled } from '$lib/server/services/app-settings';

export async function load() {
  return {
    registrationEnabled: await isRegistrationEnabled()
  };
}

export const actions = {
  updateRegistration: async ({ request, locals }) => {
    const form = await request.formData();
    const enabled = form.get('registrationEnabled') === 'on';
    try {
      await setRegistrationEnabled(enabled, locals.user!.id);
      return { saved: true, registrationEnabled: enabled };
    } catch {
      return fail(500, { error: 'Could not update registration setting.' });
    }
  }
};
