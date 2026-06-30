import type pg from 'pg';
import { rollDiceExpression } from '$lib/rules/dnd5e';
import { applyCharacterEffect, removeCharacterEffect } from '$lib/server/services/effects';

export type ActionResult = { label:string; target:string; expression:string; rolled:number; before:number|null; after:number|null; detail?:string };

export async function executeContentActions(client:pg.PoolClient,characterId:string,contentId:string,triggers:string[],context:{inventoryId?:string;instanceId?:string}={}):Promise<ActionResult[]>{
  const rows=await client.query<any>(`SELECT action.id,action.name,step.* FROM content_action_links link
    JOIN action_definitions action ON action.id=link.action_id
    JOIN action_steps step ON step.action_id=action.id
    WHERE link.content_id=$1 AND link.trigger_type=ANY($2::text[]) AND action.is_archived=false
    ORDER BY link.sort_order,action.name,step.sort_order,step.created_at`,[contentId,triggers]);
  const results:ActionResult[]=[];
  for(const step of rows.rows)results.push(...await executeStep(client,characterId,step,context));
  return results;
}

async function executeStep(client:pg.PoolClient,characterId:string,step:any,context:{inventoryId?:string;instanceId?:string}):Promise<ActionResult[]>{
  const amount=step.value_expression?rollDiceExpression(step.value_expression):0;
  const label=step.label||step.name;
  if(step.step_type==='resource_change'){
    const result=await applyResourceChange(client,characterId,step,amount);
    return result?[{...result,label,expression:step.value_expression,rolled:amount}]:[];
  }
  if(step.step_type==='damage'||step.step_type==='healing'||step.step_type==='roll_output'){
    if(step.target_mode==='external_roll')return[{label,target:'External target',expression:step.value_expression,rolled:amount,before:null,after:null,detail:`${label}: ${amount}`}];
    const operation=step.step_type==='damage'?'subtract':'add';
    const result=await applyResourceChange(client,characterId,{...step,target_type:'hp',operation},amount);
    return result?[{...result,label,expression:step.value_expression,rolled:amount}]:[];
  }
  if(step.step_type==='apply_effect'&&step.effect_id){
    const applied=await applyCharacterEffect(client,characterId,step.effect_id,{sourceContentInstanceId:context.instanceId,sourceKey:context.inventoryId?`inventory:${context.inventoryId}`:null});
    return[{label,target:applied.name,expression:'',rolled:0,before:null,after:null,detail:applied.status}];
  }
  if(step.step_type==='remove_effect'&&step.effect_id){
    const removed=await removeCharacterEffect(client,characterId,step.effect_id);
    return[{label,target:'Effect',expression:'',rolled:removed,before:null,after:null,detail:removed?'removed':'not active'}];
  }
  if(step.step_type==='spend_item'){
    if(!context.inventoryId)throw new Error(`${label} requires an inventory item.`);
    const spent=await client.query(`UPDATE character_inventory_items SET quantity=quantity-$3
      WHERE id=$1 AND character_id=$2 AND quantity>=$3`,[context.inventoryId,characterId,Math.max(1,amount||1)]);
    if(!spent.rowCount)throw new Error(`Not enough item quantity for ${label}.`);
    return[{label,target:'Item quantity',expression:step.value_expression||'1',rolled:Math.max(1,amount||1),before:null,after:null}];
  }
  if(step.step_type==='spend_resource'){
    if(context.inventoryId){const spent=await client.query<any>(`UPDATE character_inventory_resources resource SET current_value=current_value-$3
      FROM content_resource_definitions definition WHERE resource.inventory_item_id=$1
        AND resource.resource_definition_id=definition.id AND definition.resource_key=$2 AND resource.current_value>=$3
      RETURNING resource.current_value+$3 AS before,resource.current_value AS after`,[context.inventoryId,step.target_key,Math.max(1,amount||1)]);
      if(!spent.rowCount)throw new Error(`Not enough ${step.target_key}.`);return[{label,target:step.target_key,expression:step.value_expression||'1',rolled:Math.max(1,amount||1),before:spent.rows[0].before,after:spent.rows[0].after}];}
    if(!context.instanceId)throw new Error(`${label} requires a content resource.`);
    const spent=await client.query<any>(`UPDATE character_content_resources resource SET current_value=current_value-$3
      FROM content_resource_definitions definition WHERE resource.character_content_id=$1
        AND resource.resource_definition_id=definition.id AND definition.resource_key=$2 AND resource.current_value>=$3
      RETURNING resource.current_value+$3 AS before,resource.current_value AS after`,[context.instanceId,step.target_key,Math.max(1,amount||1)]);
    if(!spent.rowCount)throw new Error(`Not enough ${step.target_key}.`);
    return[{label,target:step.target_key,expression:step.value_expression||'1',rolled:Math.max(1,amount||1),before:spent.rows[0].before,after:spent.rows[0].after}];
  }
  return[];
}

function adjustedValue(before:number,amount:number,operation:string,max:number|null){const raw=operation==='set'?amount:operation==='subtract'?before-amount:before+amount;return Math.max(0,max===null?raw:Math.min(max,raw));}

async function applyResourceChange(client:pg.PoolClient,characterId:string,step:any,amount:number):Promise<Omit<ActionResult,'label'|'expression'|'rolled'>|null>{
  if(step.target_type==='hp'||step.target_type==='temp_hp'){
    const key=step.target_type==='hp'?'hp':'temp_hp';
    const current=await client.query<any>('SELECT current_value,max_value FROM character_resources WHERE character_id=$1 AND resource_key=$2 FOR UPDATE',[characterId,key]);
    if(!current.rowCount)return null;const before=current.rows[0].current_value;const max=key==='hp'?current.rows[0].max_value:null;
    const after=adjustedValue(before,amount,step.operation,max);
    await client.query(`UPDATE character_resources SET current_value=$3,max_value=CASE WHEN resource_key='temp_hp' THEN GREATEST(max_value,$3) ELSE max_value END WHERE character_id=$1 AND resource_key=$2`,[characterId,key,after]);
    return{target:key==='hp'?'Hit Points':'Temporary HP',before,after};
  }
  if(step.target_type==='spell_slot'){
    const order=step.target_key==='lowest_expended'?'ASC':'DESC';
    const condition=step.target_key==='pact'?`slot_type='pact'`: /^\d$/.test(step.target_key)?`slot_type='standard' AND slot_level=${Number(step.target_key)}`:`slot_type='standard' AND current_slots<max_slots`;
    const slot=await client.query<any>(`SELECT slot_type,slot_level,current_slots,max_slots FROM character_spell_slots WHERE character_id=$1 AND ${condition} ORDER BY slot_level ${order} LIMIT 1 FOR UPDATE`,[characterId]);
    if(!slot.rowCount)return null;const before=slot.rows[0].current_slots;const after=adjustedValue(before,amount,step.operation,slot.rows[0].max_slots);
    await client.query('UPDATE character_spell_slots SET current_slots=$4 WHERE character_id=$1 AND slot_type=$2 AND slot_level=$3',[characterId,slot.rows[0].slot_type,slot.rows[0].slot_level,after]);
    return{target:`${slot.rows[0].slot_type==='pact'?'Pact':'Level '+slot.rows[0].slot_level} Spell Slots`,before,after};
  }
  if(step.target_type==='coin'){
    const map:Record<string,string>={cp:'currencyCp',sp:'currencySp',ep:'currencyEp',gp:'currencyGp',pp:'currencyPp'};const key=map[step.target_key];if(!key)return null;
    const current=await client.query<any>('SELECT metadata_json FROM characters WHERE id=$1 FOR UPDATE',[characterId]);const before=Number(current.rows[0]?.metadata_json?.[key])||0;
    const after=adjustedValue(before,amount,step.operation,null);await client.query(`UPDATE characters SET metadata_json=jsonb_set(metadata_json,$2::text[],to_jsonb($3::text),true),updated_at=now() WHERE id=$1`,[characterId,[key],after]);
    return{target:step.target_key.toUpperCase(),before,after};
  }
  return null;
}
