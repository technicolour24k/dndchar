import { query, withTransaction } from '$lib/server/db';
import type { ContentType } from '$lib/types/content';

export type AdminContentRecord={id:string;type:ContentType;name:string;description:string;key:string;sourceKind:string;
  isArchived:boolean;spellLevel:number|null;school:string;castingTime:string;range:string;components:string;duration:string;
  ritual:boolean;concentration:boolean;classes:string[];category:string;equipmentType:string;requiresAttunement:boolean;
  acBonus:number;toHitBonus:number;damageBonus:number;attackAbility:string;damageRolls:string;
  resolutionType:string;damageType:string;baseDice:string;saveAbility:string;saveEffect:string;scaling:any};

export async function loadContentAdmin(types:ContentType[],selectedId=''){
  const content=await query<any>(`SELECT c.*,s.spell_level,s.school,s.casting_time,s.spell_range,s.components,s.duration,
    s.ritual,s.concentration,s.classes,s.resolution_type,s.damage_type,s.base_dice,s.save_ability,s.save_effect,s.scaling_json,
    i.category,i.equipment_type,i.requires_attunement,i.ac_bonus,i.to_hit_bonus,
    i.damage_bonus,i.attack_ability,i.damage_rolls FROM content_definitions c
    LEFT JOIN spell_definitions s ON s.content_id=c.id LEFT JOIN item_definitions i ON i.content_id=c.id
    WHERE c.content_type=ANY($1::text[]) ORDER BY c.is_archived,c.name`,[types]);
  const records=content.rows.map(mapContent);const selectedContentId=records.some((entry)=>entry.id===selectedId)?selectedId:records[0]?.id||'';
  const modifiers=await query<any>(`SELECT m.id,m.target,m.modifier_type,COALESCE(m.default_value_expression,'') AS default_value_expression,
    COALESCE(m.label,'') AS label,COALESCE(t.label,m.target) AS target_label,COALESCE(t.runtime_supported,false) AS runtime_supported
    FROM modifier_definitions m LEFT JOIN modifier_targets t ON t.target_key=m.target WHERE m.is_archived=false
    ORDER BY target_label,m.modifier_type,m.default_value_expression`);
  const attached=selectedContentId?await query<any>(`SELECT link.id,link.activation_type,m.target,COALESCE(t.label,m.target) AS target_label,
    m.modifier_type,COALESCE(link.value_override_expression,m.default_value_expression,'') AS value_expression,
    COALESCE(link.condition_expression,'') AS condition_expression,link.priority
    FROM content_modifier_links link JOIN modifier_definitions m ON m.id=link.modifier_id
    LEFT JOIN modifier_targets t ON t.target_key=m.target WHERE link.content_id=$1 ORDER BY link.sort_order,link.priority,target_label`,[selectedContentId]):{rows:[]};
  const effects=await query<any>(`SELECT id,name,source_type FROM effect_definitions WHERE is_archived=false ORDER BY name`);
  const attachedEffects=selectedContentId?await query<any>(`SELECT link.id,link.effect_id,link.activation_type,effect.name,effect.duration_type
    FROM content_effect_links link JOIN effect_definitions effect ON effect.id=link.effect_id WHERE link.content_id=$1
    ORDER BY link.sort_order,effect.name`,[selectedContentId]):{rows:[]};
  const actions=selectedContentId?await query<any>(`SELECT link.id AS link_id,link.trigger_type,action.id,action.name,action.description,
    step.id AS step_id,step.step_type,step.operation,step.target_type,step.target_key,step.value_expression,
    step.effect_id,step.target_mode,step.label,step.sort_order FROM content_action_links link
    JOIN action_definitions action ON action.id=link.action_id LEFT JOIN action_steps step ON step.action_id=action.id
    WHERE link.content_id=$1 ORDER BY link.sort_order,action.name,step.sort_order`,[selectedContentId]):{rows:[]};
  const actionCandidates=await query<any>('SELECT id,name FROM action_definitions WHERE is_archived=false ORDER BY name');
  const resources=selectedContentId?await query<any>('SELECT id,resource_key,label,max_value_expression,recharge_period FROM content_resource_definitions WHERE content_id=$1 ORDER BY label',[selectedContentId]):{rows:[]};
  const grants=selectedContentId?await query<any>(`SELECT g.id,g.activation_type,c.name,c.content_type FROM content_grants g
    JOIN content_definitions c ON c.id=g.granted_content_id WHERE g.source_content_id=$1 ORDER BY c.name`,[selectedContentId]):{rows:[]};
  const grantCandidates=await query<any>(`SELECT id,name,content_type FROM content_definitions WHERE content_type IN('feat','class_feature') AND is_archived=false ORDER BY name`);
  const spellCandidates=await query<any>(`SELECT id,name FROM content_definitions WHERE content_type='spell' AND is_archived=false ORDER BY name`);
  const spellAccess=selectedContentId?await query<any>(`SELECT access.*,spell.name AS spell_name FROM content_spell_access access
    JOIN content_definitions spell ON spell.id=access.spell_content_id WHERE access.owner_content_id=$1 ORDER BY access.sort_order,spell.name`,[selectedContentId]):{rows:[]};
  return{content:records,selectedContentId,modifiers:modifiers.rows.map((row:any)=>({id:row.id,target:row.target,targetLabel:row.target_label,
    modifierType:row.modifier_type,defaultValueExpression:row.default_value_expression,label:row.label,runtimeSupported:row.runtime_supported})),
    attachedModifiers:attached.rows.map((row:any)=>({id:row.id,activationType:row.activation_type,target:row.target,targetLabel:row.target_label,
      modifierType:row.modifier_type,valueExpression:row.value_expression,conditionExpression:row.condition_expression,priority:row.priority})),
    effects:effects.rows.map((row:any)=>({id:row.id,name:row.name,sourceType:row.source_type})),
    attachedEffects:attachedEffects.rows.map((row:any)=>({id:row.id,effectId:row.effect_id,name:row.name,activationType:row.activation_type,durationType:row.duration_type})),
    actions:groupActions(actions.rows),actionCandidates:actionCandidates.rows,resources:resources.rows.map((row:any)=>({id:row.id,key:row.resource_key,label:row.label,maxValueExpression:row.max_value_expression,rechargePeriod:row.recharge_period})),
    grants:grants.rows.map((row:any)=>({id:row.id,name:row.name,type:row.content_type,activationType:row.activation_type})),
    grantCandidates:grantCandidates.rows.map((row:any)=>({id:row.id,name:row.name,type:row.content_type})),
    spellCandidates:spellCandidates.rows,spellAccess:spellAccess.rows.map(mapSpellAccess)};
}

export async function createAdminContent(userId:string,type:ContentType,form:FormData){const name=String(form.get('name')||'').trim();if(!name)throw new Error('Name is required.');
  const key=`admin:${type}:${slug(name)}:${Date.now()}`;return withTransaction(async(client)=>{const created=await client.query<{id:string}>(`INSERT INTO content_definitions
    (content_key,content_type,name,description,source_kind,owner_user_id,metadata_json) VALUES($1,$2,$3,$4,'homebrew',$5,'{}') RETURNING id`,[key,type,name,String(form.get('description')||''),userId]);
    const id=created.rows[0].id;if(type==='spell')await client.query('INSERT INTO spell_definitions(content_id,spell_level) VALUES($1,0)',[id]);
    if(type==='item')await client.query('INSERT INTO item_definitions(content_id) VALUES($1)',[id]);return id;});}

export async function updateAdminContent(form:FormData){const id=String(form.get('contentId')||'');return withTransaction(async(client)=>{
  const current=await client.query<{content_type:ContentType}>('SELECT content_type FROM content_definitions WHERE id=$1',[id]);if(!current.rowCount)throw new Error('Catalogue entry not found.');
  await client.query('UPDATE content_definitions SET name=$2,description=$3,updated_at=now() WHERE id=$1',[id,String(form.get('name')||'').trim(),String(form.get('description')||'')]);
  if(current.rows[0].content_type==='spell')await client.query(`INSERT INTO spell_definitions(content_id,spell_level,school,casting_time,spell_range,components,duration,ritual,concentration,classes,
    resolution_type,damage_type,base_dice,save_ability,save_effect,scaling_json)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb) ON CONFLICT(content_id) DO UPDATE SET spell_level=EXCLUDED.spell_level,school=EXCLUDED.school,
    casting_time=EXCLUDED.casting_time,spell_range=EXCLUDED.spell_range,components=EXCLUDED.components,duration=EXCLUDED.duration,
    ritual=EXCLUDED.ritual,concentration=EXCLUDED.concentration,classes=EXCLUDED.classes,resolution_type=EXCLUDED.resolution_type,
    damage_type=EXCLUDED.damage_type,base_dice=EXCLUDED.base_dice,save_ability=EXCLUDED.save_ability,save_effect=EXCLUDED.save_effect,
    scaling_json=EXCLUDED.scaling_json`,[id,Math.min(9,Math.max(0,Number(form.get('spellLevel'))||0)),String(form.get('school')||''),String(form.get('castingTime')||''),String(form.get('range')||''),String(form.get('components')||''),String(form.get('duration')||''),form.get('ritual')==='on',form.get('concentration')==='on',form.getAll('classes').map(String),
    String(form.get('resolutionType')||'attack'),String(form.get('damageType')||''),String(form.get('baseDice')||''),
    String(form.get('saveAbility')||'dex'),String(form.get('saveEffect')||'half'),JSON.stringify(parseSpellScaling(form))]);
  if(current.rows[0].content_type==='item')await client.query(`INSERT INTO item_definitions(content_id,category,equipment_type,requires_attunement,ac_bonus,to_hit_bonus,damage_bonus,attack_ability,damage_rolls)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(content_id) DO UPDATE SET category=EXCLUDED.category,equipment_type=EXCLUDED.equipment_type,
    requires_attunement=EXCLUDED.requires_attunement,ac_bonus=EXCLUDED.ac_bonus,to_hit_bonus=EXCLUDED.to_hit_bonus,damage_bonus=EXCLUDED.damage_bonus,
    attack_ability=EXCLUDED.attack_ability,damage_rolls=EXCLUDED.damage_rolls`,[id,String(form.get('category')||'gear'),String(form.get('equipmentType')||'item'),form.get('requiresAttunement')==='on',Number(form.get('acBonus'))||0,Number(form.get('toHitBonus'))||0,Number(form.get('damageBonus'))||0,String(form.get('attackAbility')||'str'),String(form.get('damageRolls')||'')]);return id;});}

export async function toggleAdminContentArchive(form:FormData){const id=String(form.get('contentId')||'');await query('UPDATE content_definitions SET is_archived=NOT is_archived,updated_at=now() WHERE id=$1',[id]);return id;}

export async function attachModifierToContent(form:FormData){const contentId=String(form.get('contentId')||''),modifierId=String(form.get('modifierId')||''),activation=String(form.get('activationType')||'manual');
  if(!['carried','equipped','attuned','known','prepared','manual'].includes(activation))throw new Error('On-use mechanics must be attached through an Action.');
  await query(`INSERT INTO content_modifier_links(content_id,modifier_id,activation_type,value_override_expression,condition_expression,priority,sort_order)
    VALUES($1,$2,$3,NULLIF($4,''),NULLIF($5,''),$6,COALESCE((SELECT max(sort_order)+1 FROM content_modifier_links WHERE content_id=$1),0)) ON CONFLICT DO NOTHING`,
    [contentId,modifierId,activation,String(form.get('valueOverrideExpression')||'').trim(),String(form.get('conditionExpression')||'').trim(),Number(form.get('priority'))||0]);return contentId;}
export async function detachContentModifier(form:FormData){const id=String(form.get('contentId')||'');await query('DELETE FROM content_modifier_links WHERE id=$1 AND content_id=$2',[String(form.get('linkId')||''),id]);return id;}

export async function attachEffectToAdminContent(form:FormData){const id=String(form.get('contentId')||''),effectId=String(form.get('effectId')||''),activation=String(form.get('activationType')||'manual');
  return withTransaction(async client=>{if(activation!=='on_use'){await client.query(`INSERT INTO content_effect_links(content_id,effect_id,activation_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[id,effectId,activation]);return id;}
    const content=await client.query<any>('SELECT name,owner_user_id FROM content_definitions WHERE id=$1',[id]);if(!content.rowCount)throw new Error('Content not found.');
    const action=await client.query<{id:string}>(`INSERT INTO action_definitions(action_key,name,description,owner_user_id) VALUES($1,$2,$3,$4)
      ON CONFLICT(action_key) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[`content:${id}:on_use`,`Use ${content.rows[0].name}`,`Actions for ${content.rows[0].name}`,content.rows[0].owner_user_id]);
    await client.query("INSERT INTO content_action_links(content_id,action_id,trigger_type) VALUES($1,$2,'on_use') ON CONFLICT DO NOTHING",[id,action.rows[0].id]);
    await client.query(`INSERT INTO action_steps(action_id,step_type,operation,effect_id,label,sort_order)
      SELECT $1,'apply_effect','apply',$2,effect.name,COALESCE((SELECT max(sort_order)+1 FROM action_steps WHERE action_id=$1),0)
      FROM effect_definitions effect WHERE effect.id=$2 AND NOT EXISTS(SELECT 1 FROM action_steps WHERE action_id=$1 AND step_type='apply_effect' AND effect_id=$2)`,[action.rows[0].id,effectId]);return id;});}
export async function detachEffectFromAdminContent(form:FormData){const id=String(form.get('contentId')||'');await query('DELETE FROM content_effect_links WHERE id=$1 AND content_id=$2',[String(form.get('linkId')||''),id]);return id;}

export async function addContentResourceAction(form:FormData){const contentId=String(form.get('contentId')||''),trigger=String(form.get('activationType')||'on_use')==='on_use'?'on_use':'manual';
  const stepType=String(form.get('stepType')||'resource_change'),operation=String(form.get('actionOperation')||'add'),target=String(form.get('targetType')||''),key=String(form.get('targetKey')||''),rawExpression=String(form.get('valueExpression')||'');
  const expression=['apply_effect','remove_effect'].includes(stepType)?'':validateDice(rawExpression||'0');
  if(!['resource_change','damage','healing','apply_effect','remove_effect','spend_resource','spend_item','roll_output'].includes(stepType))throw new Error('Choose a valid action step.');
  if(stepType==='resource_change'&&(!['add','subtract','set'].includes(operation)||!['hp','temp_hp','spell_slot','coin'].includes(target)))throw new Error('Choose a valid resource action.');
  return withTransaction(async(client)=>{const content=await client.query<any>('SELECT name,owner_user_id FROM content_definitions WHERE id=$1',[contentId]);if(!content.rowCount)throw new Error('Content not found.');
    const requestedAction=String(form.get('actionId')||'');const action=requestedAction
      ? await client.query<{id:string}>('SELECT action.id FROM action_definitions action JOIN content_action_links link ON link.action_id=action.id WHERE action.id=$1 AND link.content_id=$2',[requestedAction,contentId])
      : await client.query<{id:string}>(`INSERT INTO action_definitions(action_key,name,description,owner_user_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(action_key) DO UPDATE SET name=EXCLUDED.name RETURNING id`,[`content:${contentId}:${trigger}`,`${trigger==='on_use'?'Use':'Activate'} ${content.rows[0].name}`,`Actions for ${content.rows[0].name}`,content.rows[0].owner_user_id]);
    if(!action.rowCount)throw new Error('Attach the Action before adding steps.');
    await client.query('INSERT INTO content_action_links(content_id,action_id,trigger_type) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[contentId,action.rows[0].id,trigger]);
    await client.query(`INSERT INTO action_steps(action_id,step_type,operation,target_type,target_key,value_expression,effect_id,target_mode,label,sort_order)
      VALUES($1,$2,$3,$4,$5,$6,NULLIF($7,'')::uuid,$8,$9,COALESCE((SELECT max(sort_order)+1 FROM action_steps WHERE action_id=$1),0))`,
      [action.rows[0].id,stepType,operation,target,key,expression,String(form.get('effectId')||''),String(form.get('targetMode')||'self'),String(form.get('actionLabel')||'').trim()]);return contentId;});}
export async function removeContentResourceAction(form:FormData){const id=String(form.get('contentId')||'');await query('DELETE FROM action_steps WHERE id=$1',[String(form.get('actionId')||'')]);return id;}

export async function attachActionToContent(form:FormData){const id=String(form.get('contentId')||'');await query(`INSERT INTO content_action_links(content_id,action_id,trigger_type)
  VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[id,String(form.get('actionId')||''),String(form.get('triggerType')||'manual')]);return id;}
export async function detachActionFromContent(form:FormData){const id=String(form.get('contentId')||'');await query('DELETE FROM content_action_links WHERE id=$1 AND content_id=$2',[String(form.get('linkId')||''),id]);return id;}

export async function addSpellAccess(form:FormData){const owner=String(form.get('contentId')||'');await query(`INSERT INTO content_spell_access
  (owner_content_id,spell_content_id,access_type,availability_type,resource_definition_id,resource_cost_expression,cast_level_mode,fixed_cast_level,save_dc_mode,fixed_save_dc,spell_attack_mode,fixed_spell_attack_bonus)
  VALUES($1,$2,$3,$4,NULLIF($5,'')::uuid,$6,$7,NULLIF($8,'')::int,$9,NULLIF($10,'')::int,$11,NULLIF($12,'')::int) ON CONFLICT(owner_content_id,spell_content_id,access_type) DO UPDATE SET
  availability_type=EXCLUDED.availability_type,resource_definition_id=EXCLUDED.resource_definition_id,resource_cost_expression=EXCLUDED.resource_cost_expression,
  cast_level_mode=EXCLUDED.cast_level_mode,fixed_cast_level=EXCLUDED.fixed_cast_level,save_dc_mode=EXCLUDED.save_dc_mode,fixed_save_dc=EXCLUDED.fixed_save_dc,
  spell_attack_mode=EXCLUDED.spell_attack_mode,fixed_spell_attack_bonus=EXCLUDED.fixed_spell_attack_bonus`,[owner,String(form.get('spellContentId')||''),String(form.get('accessType')||'at_will'),String(form.get('availabilityType')||'equipped'),String(form.get('resourceDefinitionId')||''),String(form.get('resourceCostExpression')||'1'),String(form.get('castLevelMode')||'spell_level'),String(form.get('fixedCastLevel')||''),String(form.get('saveDcMode')||'character'),String(form.get('fixedSaveDc')||''),String(form.get('spellAttackMode')||'character'),String(form.get('fixedSpellAttackBonus')||'')]);return owner;}
export async function removeSpellAccess(form:FormData){const id=String(form.get('contentId')||'');await query('DELETE FROM content_spell_access WHERE id=$1 AND owner_content_id=$2',[String(form.get('accessId')||''),id]);return id;}

function groupActions(rows:any[]){const map=new Map<string,any>();for(const row of rows){const action=map.get(row.id)||{id:row.id,linkId:row.link_id,name:row.name,description:row.description,triggerType:row.trigger_type,steps:[]};if(row.step_id)action.steps.push({id:row.step_id,type:row.step_type,operation:row.operation,targetType:row.target_type,targetKey:row.target_key,valueExpression:row.value_expression,effectId:row.effect_id,targetMode:row.target_mode,label:row.label,sortOrder:row.sort_order});map.set(row.id,action);}return[...map.values()];}
function mapSpellAccess(row:any){return{id:row.id,spellContentId:row.spell_content_id,spellName:row.spell_name,accessType:row.access_type,availabilityType:row.availability_type,resourceDefinitionId:row.resource_definition_id,resourceCostExpression:row.resource_cost_expression,castLevelMode:row.cast_level_mode,fixedCastLevel:row.fixed_cast_level,saveDcMode:row.save_dc_mode,fixedSaveDc:row.fixed_save_dc,spellAttackMode:row.spell_attack_mode,fixedSpellAttackBonus:row.fixed_spell_attack_bonus};}
function mapContent(row:any):AdminContentRecord{return{id:row.id,type:row.content_type,name:row.name,description:row.description,key:row.content_key,sourceKind:row.source_kind,isArchived:row.is_archived,spellLevel:row.spell_level,school:row.school||'',castingTime:row.casting_time||'',range:row.spell_range||'',components:row.components||'',duration:row.duration||'',ritual:Boolean(row.ritual),concentration:Boolean(row.concentration),classes:row.classes||[],category:row.category||'gear',equipmentType:row.equipment_type||'item',requiresAttunement:Boolean(row.requires_attunement),acBonus:row.ac_bonus||0,toHitBonus:row.to_hit_bonus||0,damageBonus:row.damage_bonus||0,attackAbility:row.attack_ability||'str',damageRolls:row.damage_rolls||'',
  resolutionType:row.resolution_type||'attack',damageType:row.damage_type||'',baseDice:row.base_dice||'',saveAbility:row.save_ability||'dex',saveEffect:row.save_effect||'half',scaling:row.scaling_json||{}};}
// Builds spell_definitions.scaling_json from the admin form's plain inputs - a
// "Scales?" kind select gates which pair of fields is read, so authoring a
// non-scaling spell (most saves/debuffs) just leaves both blank -> {}.
function parseSpellScaling(form:FormData):Record<string,unknown>{
  const kind=String(form.get('scalingKind')||'none');
  if(kind==='cantrip')return{kind,extraDice:String(form.get('scalingExtraDice')||''),
    tiers:String(form.get('scalingTiers')||'').split(',').map((value)=>Number(value.trim())).filter((value)=>Number.isFinite(value)&&value>0)};
  if(kind==='leveled')return{kind,extraDicePerSlotLevel:String(form.get('scalingExtraDicePerSlotLevel')||'')||null};
  return{};
}
function validateDice(value:string){const result=value.replace(/\s+/g,'');if(!/^(?:\d*d\d+|\d+)(?:[+-](?:\d*d\d+|\d+))*$/i.test(result))throw new Error('Amount must contain only numbers, dice, +, and -.');return result;}
function slug(value:string){return value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')||'content';}
