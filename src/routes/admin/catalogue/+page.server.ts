import { fail } from '@sveltejs/kit';
import { listAdminCatalogue, publishContent } from '$lib/server/services/catalogue';
import { attachModifierToEffect, createModifier, createModifierTarget, detachModifierFromEffect, loadGenericEffectAdmin, loadModifierCatalogue, modifierTypes, updateEffect } from '$lib/server/services/modifier-admin';

export async function load({url}){return{content:await listAdminCatalogue(),...(await loadModifierCatalogue()),...(await loadGenericEffectAdmin(url.searchParams.get('effect')||'')),modifierTypes};}
export const actions={
  publish:async({request})=>{try{const form=await request.formData();await publishContent(String(form.get('contentId')||''),String(form.get('status')||'private') as any);return{saved:true};}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not update publication.'});}},
  createTarget:async({request})=>{try{await createModifierTarget(await request.formData());return{saved:true};}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not create target.'});}},
  createModifier:async({request})=>{try{await createModifier(await request.formData());return{saved:true};}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not create modifier.'});}},
  updateEffect:async({request})=>{try{await updateEffect(await request.formData());return{saved:true};}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not update effect.'});}},
  attachEffectModifier:async({request})=>{try{await attachModifierToEffect(await request.formData());return{saved:true};}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not attach modifier.'});}},
  detachEffectModifier:async({request})=>{try{await detachModifierFromEffect(await request.formData());return{saved:true};}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not remove modifier.'});}}
};
