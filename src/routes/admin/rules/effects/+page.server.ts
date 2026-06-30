import { fail } from '@sveltejs/kit';
import { archiveEffect, attachEffectModifier, detachEffectModifier, loadEffects, loadModifiers, saveEffect } from '$lib/server/services/rules-admin';
export async function load({url}){return{...(await loadEffects(url.searchParams.get('effect')||'',url.searchParams.get('q')||'')),modifiers:(await loadModifiers()).modifiers};}
const run=(handler:(event:any)=>Promise<any>)=>async(event:any)=>{try{return{saved:true,id:await handler(event)}}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not save Effect.'})}};
export const actions={
  save:run(async({request,locals})=>saveEffect(locals.user!.id,await request.formData())),
  attach:run(async({request})=>attachEffectModifier(await request.formData())),
  detach:run(async({request})=>{const form=await request.formData();await detachEffectModifier(String(form.get('effectId')||''),String(form.get('linkId')||''));return String(form.get('effectId')||'')}),
  archive:run(async({request})=>archiveEffect(String((await request.formData()).get('effectId')||'')))
};
