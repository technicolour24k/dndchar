import { fail } from '@sveltejs/kit';
import { addOwnedContentResourceDefinition, attachEffectToOwnedContent, createHomebrewContent, listCatalogue, listEffectsForLinking, requestPublication } from '$lib/server/services/catalogue';
import type { ContentType } from '$lib/types/content';

export async function load({ locals, url }) {
  const rawType = url.searchParams.get('type') || '';
  const type = ['item', 'spell', 'feat', 'class_feature'].includes(rawType) ? rawType as ContentType : undefined;
  return { content: await listCatalogue(locals.user!.id, type, url.searchParams.get('search') || ''), effects: await listEffectsForLinking(locals.user!.id), type: rawType };
}

export const actions = {
  create: async ({ request, locals }) => {
    try { await createHomebrewContent(locals.user!.id, await request.formData()); return { created: true }; }
    catch (error) { return fail(400, { error: error instanceof Error ? error.message : 'Could not create homebrew content.' }); }
  },
  requestPublication: async ({ request, locals }) => {
    try { const form = await request.formData(); await requestPublication(locals.user!.id, String(form.get('contentId') || '')); return { requested: true }; }
    catch (error) { return fail(400, { error: error instanceof Error ? error.message : 'Could not request publication.' }); }
  },
  attachEffect: async ({ request, locals }) => {
    try { await attachEffectToOwnedContent(locals.user!.id, await request.formData()); return { updated: true }; }
    catch (error) { return fail(400, { error: error instanceof Error ? error.message : 'Could not attach effect.' }); }
  },
  addResource: async ({ request, locals }) => {
    try { await addOwnedContentResourceDefinition(locals.user!.id, await request.formData()); return { updated: true }; }
    catch (error) { return fail(400, { error: error instanceof Error ? error.message : 'Could not add resource.' }); }
  }
};
