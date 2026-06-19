import { error, fail } from '@sveltejs/kit';
import { emitRealtimeEvent } from '$lib/server/realtime';
import { getCharacter, listItemCategories, listVersions, restoreCharacterVersion, updateCharacter } from '$lib/server/services/characters';
import { addContentToCharacter, advanceCharacterRound, advanceCharacterTurn, createHomebrewContent, listCatalogue, removeContentFromCharacter, restCharacter, setCharacterContentState, spendSpellSlot, triggerCharacterContentActions, useContentResource, useInventoryCatalogueItem } from '$lib/server/services/catalogue';

export async function load({ params, locals }) {
  const character = await getCharacter(locals.user!.id, params.id);
  if (!character) throw error(404, 'Character not found.');

  return {
    character,
    itemCategories: await listItemCategories(),
    catalogue: await listCatalogue(locals.user!.id),
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
  },
  addContent: async ({ request, params, locals }) => {
    const form = await request.formData();
    await addContentToCharacter(locals.user!.id, params.id, String(form.get('contentId') || ''));
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  createHomebrew: async ({ request, params, locals }) => {
    const form = await request.formData();
    const contentId = await createHomebrewContent(locals.user!.id, form);
    await addContentToCharacter(locals.user!.id, params.id, contentId);
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  removeContent: async ({ request, params, locals }) => {
    const form = await request.formData();
    await removeContentFromCharacter(locals.user!.id, params.id, String(form.get('instanceId') || ''));
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  contentState: async ({ request, params, locals }) => {
    const form = await request.formData();
    await setCharacterContentState(locals.user!.id, params.id, String(form.get('instanceId') || ''), form);
    emitRealtimeEvent('character:updated', { characterId: params.id });
    return { contentUpdated: true };
  },
  contentResource: async ({ request, params, locals }) => {
    const form = await request.formData();
    await useContentResource(locals.user!.id, params.id, String(form.get('resourceId') || ''), Number(form.get('delta')) || 0);
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  },
  spellSlot: async ({ request, params, locals }) => {
    const form = await request.formData();
    await spendSpellSlot(locals.user!.id, params.id, String(form.get('slotType')) as 'standard' | 'pact', Number(form.get('slotLevel')), Number(form.get('delta')) || 0);
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  },
  rest: async ({ request, params, locals }) => {
    const form = await request.formData();
    await restCharacter(locals.user!.id, params.id, String(form.get('restType')) as 'short_rest' | 'long_rest');
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true };
  },
  advanceRound: async ({ params, locals }) => {
    await advanceCharacterRound(locals.user!.id, params.id);
    emitRealtimeEvent('round:advanced', { characterId: params.id });
    return { contentUpdated: true };
  },
  advanceTurn: async ({ params, locals }) => {
    await advanceCharacterTurn(locals.user!.id, params.id);
    emitRealtimeEvent('round:advanced', { characterId: params.id });
    return { contentUpdated: true };
  },
  useItem: async ({ request, params, locals }) => {
    const form = await request.formData();
    const itemResult=await useInventoryCatalogueItem(locals.user!.id, params.id, String(form.get('inventoryId') || ''));
    emitRealtimeEvent('resource:changed', { characterId: params.id });
    return { contentUpdated: true, itemResult };
  },
  triggerContent:async({request,params,locals})=>{
    const form=await request.formData();
    const itemResult=await triggerCharacterContentActions(locals.user!.id,params.id,String(form.get('instanceId')||''));
    emitRealtimeEvent('resource:changed',{characterId:params.id});
    return{contentUpdated:true,itemResult};
  }
};
