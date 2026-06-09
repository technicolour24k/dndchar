import { fail, redirect } from '@sveltejs/kit';
import {
  attachModifierToEffect,
  createEffect,
  createModifier,
  detachModifierFromEffect,
  loadModifierAdmin,
  modifierTargets,
  modifierTypes,
  seedCoreEffects,
  updateEffect
} from '$lib/server/services/modifier-admin';

function redirectTo(effectId: string): never {
  throw redirect(303, `/admin/modifiers?effect=${effectId}`);
}

export async function load({ url }) {
  return {
    ...(await loadModifierAdmin(url.searchParams.get('effect') || '')),
    modifierTargets,
    modifierTypes,
    targetLabelEntries: Object.fromEntries(modifierTargets),
    typeLabelEntries: Object.fromEntries(modifierTypes)
  };
}

export const actions = {
  seedCore: async () => {
    await seedCoreEffects();
    return { seeded: true };
  },
  createEffect: async ({ request, locals }) => {
    try {
      const effectId = await createEffect(locals.user!.id, await request.formData());
      redirectTo(effectId);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : 'Could not create effect.' });
    }
  },
  updateEffect: async ({ request }) => {
    try {
      const effectId = await updateEffect(await request.formData());
      redirectTo(effectId);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : 'Could not update effect.' });
    }
  },
  createModifier: async ({ request, url }) => {
    try {
      await createModifier(await request.formData());
      redirectTo(url.searchParams.get('effect') || '');
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : 'Could not create modifier.' });
    }
  },
  attachModifier: async ({ request }) => {
    try {
      const effectId = await attachModifierToEffect(await request.formData());
      redirectTo(effectId);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : 'Could not attach modifier.' });
    }
  },
  detachModifier: async ({ request }) => {
    try {
      const effectId = await detachModifierFromEffect(await request.formData());
      redirectTo(effectId);
    } catch (error) {
      return fail(400, { error: error instanceof Error ? error.message : 'Could not detach modifier.' });
    }
  }
};
