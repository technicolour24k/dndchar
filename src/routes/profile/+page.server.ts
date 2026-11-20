import { fail, redirect } from '@sveltejs/kit';
import { updateProfile } from '$lib/server/services/profile';

export function load({ locals, url }) {
  if (!locals.user) throw redirect(303, '/login');

  return {
    saved: url.searchParams.get('saved') === '1',
    user: locals.user
  };
}

export const actions = {
  save: async ({ request, locals }) => {
    try {
      await updateProfile(locals.user!.id, await request.formData());
    } catch {
      return fail(400, { error: 'Could not update profile.' });
    }

    throw redirect(303, '/profile?saved=1');
  }
};
