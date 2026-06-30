import { fail } from '@sveltejs/kit';
import { archiveRuleHook, createRuleHook, loadRuleHooks } from '$lib/server/services/rules-admin';
export async function load({url}){return{hooks:await loadRuleHooks(url.searchParams.get('q')||'')}}
export const actions={create:async({request})=>{try{return{saved:true,key:await createRuleHook(await request.formData())}}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not create Rule Hook.'})}},archive:async({request})=>{try{await archiveRuleHook(String((await request.formData()).get('targetKey')||''));return{saved:true}}catch(error){return fail(400,{error:error instanceof Error?error.message:'Could not archive Rule Hook.'})}}};
