import { fail } from '@sveltejs/kit';
import { listCharacters } from '$lib/server/services/characters';
import { addEncounterParticipant, advanceEncounterTurn, createEncounter, listEncounters } from '$lib/server/services/encounters';

export async function load({ locals }) { return { encounters: await listEncounters(locals.user!.id), characters: await listCharacters(locals.user!.id) }; }
export const actions = {
  create: async ({ request, locals }) => { const form=await request.formData(); await createEncounter(locals.user!.id,String(form.get('name')||'')); return { updated:true }; },
  addParticipant: async ({ request, locals }) => { const form=await request.formData(); try { await addEncounterParticipant(locals.user!.id,String(form.get('encounterId')),String(form.get('characterId')),Number(form.get('initiative'))||0); return {updated:true}; } catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not add participant.'});} },
  advance: async ({ request, locals }) => { const form=await request.formData(); await advanceEncounterTurn(locals.user!.id,String(form.get('encounterId'))); return {updated:true}; }
};
