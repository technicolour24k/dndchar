import { fail } from '@sveltejs/kit';
import { archiveModifier, loadModifiers, loadRuleHooks, operationRegistry, saveModifier } from '$lib/server/services/rules-admin';

export async function load({url}){return{...(await loadModifiers(url.searchParams.get('modifier')||'',url.searchParams.get('q')||'')),hooks:await loadRuleHooks(),operations:operationRegistry};}
export const actions={
  create:run(async({request})=>saveModifier(await request.formData(),'create')),
  update:run(async({request})=>saveModifier(await request.formData(),'update')),
  copy:run(async({request})=>saveModifier(await request.formData(),'copy')),
  archive:run(async({request})=>archiveModifier(String((await request.formData()).get('modifierId')||'')))
};
function run(handler:(event:any)=>Promise<any>){return async(event:any)=>{try{return{saved:true,id:await handler(event)}}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not save Modifier.'})}};}
