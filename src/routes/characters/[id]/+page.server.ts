import { error, fail } from '@sveltejs/kit';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { getCharacter, listItemCategories, listVersions, restoreCharacterVersion, updateCharacter } from '$lib/server/services/characters';

export async function load({ params, locals }) {
  const character = await getCharacter(locals.user!.id, params.id);
  if (!character) throw error(404, 'Character not found.');

  return {
    character,
    itemCategories: await listItemCategories(),
    versions: await listVersions(locals.user!.id, params.id)
  };
}

export const actions = {
  save: async ({ request, params, locals }) => {
    const form = await request.formData();
    await updateCharacter(locals.user!.id, params.id, form, 'Manual save');
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { saved: true };
  },
  autosave: async ({ request, params, locals }) => {
    const form = await request.formData();
    await updateCharacter(locals.user!.id, params.id, form, 'Autosave');
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { autosaved: true };
  },
  resource: async ({ request, params, locals }) => {
    const form = await request.formData();
    await updateCharacter(locals.user!.id, params.id, form, 'Resource update');
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return fail(200, { resourceUpdated: true });
  },
  restoreVersion: async ({ request, params, locals }) => {
    const form = await request.formData();
    const versionId = String(form.get('versionId') || '');
    if (!versionId) return fail(400, { restoreFailed: true });

    await restoreCharacterVersion(locals.user!.id, params.id, versionId);
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { restored: true };
  }
};
