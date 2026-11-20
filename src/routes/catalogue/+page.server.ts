import { fail } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/authorization';
import { addOwnedContentResourceDefinition, attachEffectToOwnedContent, createHomebrewContent, listCatalogue, listEffectsForLinking, setContentArchived, updateOwnedContent } from '$lib/server/services/catalogue';
import type { ContentType } from '$lib/types/content';

export async function load({ locals, url }) {
  const rawType = url.searchParams.get('type') || '';
  const type = ['item', 'spell', 'feat', 'class_feature'].includes(rawType) ? rawType as ContentType : undefined;
  return { content: await listCatalogue(locals.user!.id, type, url.searchParams.get('search') || ''), effects: await listEffectsForLinking(locals.user!.id), type: rawType };
}

export const actions = {
  create: async ({ request, locals }) => {
    requireAdmin(locals.user);
    try { await createHomebrewContent(locals.user!.id, await request.formData()); return { created: true }; }
    catch (error) { return fail(400, { error: error instanceof Error ? error.message : 'Could not create homebrew content.' }); }
  },
  updateOwned:async({request,locals})=>{try{await updateOwnedContent(locals.user!.id,await request.formData());return{updated:true}}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not update homebrew.'})}},
  archiveOwned:async({request,locals})=>{try{const form=await request.formData();await setContentArchived(locals.user!.id,String(form.get('contentId')||''));return{updated:true}}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not archive homebrew.'})}},
  attachEffect: async ({ request, locals }) => {
    requireAdmin(locals.user);
    try { await attachEffectToOwnedContent(locals.user!.id, await request.formData()); return { updated: true }; }
    catch (error) { return fail(400, { error: error instanceof Error ? error.message : 'Could not attach effect.' }); }
  },
  addResource: async ({ request, locals }) => {
    requireAdmin(locals.user);
    try { await addOwnedContentResourceDefinition(locals.user!.id, await request.formData()); return { updated: true }; }
    catch (error) { return fail(400, { error: error instanceof Error ? error.message : 'Could not add resource.' }); }
  }
};
