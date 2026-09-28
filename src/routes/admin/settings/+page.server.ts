import { fail } from '@sveltejs/kit';
import { isRegistrationEnabled, setRegistrationEnabled } from '$lib/server/services/app-settings';
import { invalidateReferenceData } from '$lib/server/cache/referenceData';

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
  },
  // db-traffic-reduction Phase 3: this route is already admin-only (hooks.server.ts gates the
  // whole /admin subtree via requireAdmin), so no extra check is needed here. Clears the entire
  // reference-data cache - catalogue search index, effect/condition definitions, item
  // categories - which is the fix after running a script or manual SQL that bypassed the
  // in-app invalidation hooks. Cheap: the next read just re-queries and re-caches.
  reloadCatalogue: async () => {
    invalidateReferenceData('admin reload button');
    return { catalogueReloaded: true };
  }
};
