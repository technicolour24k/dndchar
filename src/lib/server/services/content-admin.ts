import { query, withTransaction } from '$lib/server/db';
import type { ContentType } from '$lib/types/content';

export type AdminContentRecord = {
  id: string;
  type: ContentType;
  name: string;
  description: string;
  key: string;
  sourceKind: string;
  publicationStatus: string;
  spellLevel: number | null;
  school: string;
  castingTime: string;
  range: string;
  components: string;
  duration: string;
  ritual: boolean;
  concentration: boolean;
  classes: string[];
  category: string;
  equipmentType: string;
  requiresAttunement: boolean;
  acBonus: number;
  toHitBonus: number;
  damageBonus: number;
  attackAbility: string;
  damageRolls: string;
};

export async function loadContentAdmin(types: ContentType[], selectedId = '') {
  const content = await query<any>(`
    SELECT c.*, s.spell_level, s.school, s.casting_time, s.spell_range, s.components, s.duration,
      s.ritual, s.concentration, s.classes,
      i.category, i.equipment_type, i.requires_attunement, i.ac_bonus, i.to_hit_bonus,
      i.damage_bonus, i.attack_ability, i.damage_rolls
    FROM content_definitions c
    LEFT JOIN spell_definitions s ON s.content_id=c.id
    LEFT JOIN item_definitions i ON i.content_id=c.id
    WHERE c.content_type=ANY($1::text[])
    ORDER BY c.name`, [types]);
  const records = content.rows.map(mapContent);
  const selectedContentId = records.some((entry) => entry.id === selectedId) ? selectedId : records[0]?.id || '';
  const modifiers = await query<any>(`SELECT m.id, m.target, m.modifier_type,
      COALESCE(m.default_value_expression,'') AS default_value_expression,
      COALESCE(m.label,'') AS label, COALESCE(t.label,m.target) AS target_label,
      COALESCE(t.runtime_supported,false) AS runtime_supported
    FROM modifier_definitions m LEFT JOIN modifier_targets t ON t.target_key=m.target
    ORDER BY target_label,m.modifier_type,m.default_value_expression`);
  const attached = selectedContentId ? await query<any>(`SELECT ml.id, e.name AS effect_name,
      cel.activation_type, m.target, COALESCE(t.label,m.target) AS target_label, m.modifier_type,
      COALESCE(ml.value_override_expression,m.default_value_expression,'') AS value_expression,
      COALESCE(ml.condition_expression,'') AS condition_expression, ml.priority
    FROM content_effect_links cel JOIN effect_definitions e ON e.id=cel.effect_id
    JOIN effect_modifier_links ml ON ml.effect_id=e.id
    JOIN modifier_definitions m ON m.id=ml.modifier_id
    LEFT JOIN modifier_targets t ON t.target_key=m.target
    WHERE cel.content_id=$1 ORDER BY cel.activation_type,ml.priority,target_label`, [selectedContentId]) : { rows: [] };
  const resources=selectedContentId?await query<any>(`SELECT id,resource_key,label,max_value_expression,recharge_period
    FROM content_resource_definitions WHERE content_id=$1 ORDER BY label`,[selectedContentId]):{rows:[]};
  const grants=selectedContentId?await query<any>(`SELECT g.id,g.activation_type,c.name,c.content_type
    FROM content_grants g JOIN content_definitions c ON c.id=g.granted_content_id
    WHERE g.source_content_id=$1 ORDER BY c.name`,[selectedContentId]):{rows:[]};
  const grantCandidates=await query<any>(`SELECT id,name,content_type FROM content_definitions
    WHERE content_type IN('feat','class_feature') ORDER BY name`);
  const resourceActions=selectedContentId?await query<any>(`SELECT id,action_operation,target_type,target_key,
    value_expression,activation_type,label FROM content_resource_actions WHERE content_id=$1 ORDER BY sort_order,created_at`,
    [selectedContentId]):{rows:[]};
  return {
    content: records,
    selectedContentId,
    modifiers: modifiers.rows.map((row: any) => ({ id: row.id, target: row.target, targetLabel: row.target_label,
      modifierType: row.modifier_type, defaultValueExpression: row.default_value_expression,
      label: row.label, runtimeSupported: row.runtime_supported })),
    attachedModifiers: attached.rows.map((row: any) => ({ id: row.id, effectName: row.effect_name,
      activationType: row.activation_type, target: row.target, targetLabel: row.target_label,
      modifierType: row.modifier_type, valueExpression: row.value_expression,
      conditionExpression: row.condition_expression, priority: row.priority })),
    resources:resources.rows.map((row:any)=>({id:row.id,key:row.resource_key,label:row.label,
      maxValueExpression:row.max_value_expression,rechargePeriod:row.recharge_period})),
    grants:grants.rows.map((row:any)=>({id:row.id,name:row.name,type:row.content_type,activationType:row.activation_type})),
    grantCandidates:grantCandidates.rows.map((row:any)=>({id:row.id,name:row.name,type:row.content_type})),
    resourceActions:resourceActions.rows.map((row:any)=>({id:row.id,operation:row.action_operation,
      targetType:row.target_type,targetKey:row.target_key,valueExpression:row.value_expression,
      activationType:row.activation_type,label:row.label}))
  };
}

export async function addContentResourceAction(form:FormData):Promise<string>{
  const contentId=String(form.get('contentId')||'');
  const operation=String(form.get('actionOperation')||'');
  const targetType=String(form.get('targetType')||'');
  const targetKey=String(form.get('targetKey')||'');
  const expression=String(form.get('valueExpression')||'').replace(/\s+/g,'');
  if(!['add','subtract','set'].includes(operation))throw new Error('Choose a valid operation.');
  if(!['hp','temp_hp','spell_slot','coin'].includes(targetType))throw new Error('Choose a valid target.');
  if(!/^(?:\d*d\d+|\d+)(?:[+-](?:\d*d\d+|\d+))*$/i.test(expression))throw new Error('Amount must contain only numbers, dice, +, and -.');
  if(targetType==='coin'&&!['cp','sp','ep','gp','pp'].includes(targetKey))throw new Error('Choose a coin type.');
  if(targetType==='spell_slot'&&!['highest_expended','lowest_expended','pact','1','2','3','4','5','6','7','8','9'].includes(targetKey))throw new Error('Choose a spell-slot target.');
  await query(`INSERT INTO content_resource_actions
    (content_id,action_operation,target_type,target_key,value_expression,activation_type,label,sort_order)
    VALUES($1,$2,$3,$4,$5,$6,$7,COALESCE((SELECT max(sort_order)+1 FROM content_resource_actions WHERE content_id=$1),0))`,
    [contentId,operation,targetType,targetKey,expression,String(form.get('activationType')||'on_use'),String(form.get('actionLabel')||'').trim()]);
  return contentId;
}

export async function removeContentResourceAction(form:FormData):Promise<string>{
  const contentId=String(form.get('contentId')||'');
  await query('DELETE FROM content_resource_actions WHERE id=$1 AND content_id=$2',[String(form.get('actionId')||''),contentId]);
  return contentId;
}

export async function createAdminContent(userId: string, type: ContentType, form: FormData): Promise<string> {
  const name = String(form.get('name') || '').trim();
  if (!name) throw new Error('Name is required.');
  const key = `admin:${type}:${name.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'')}:${Date.now()}`;
  return withTransaction(async (client) => {
    const created = await client.query<{id:string}>(`INSERT INTO content_definitions
      (content_key,content_type,name,description,source_kind,owner_user_id,publication_status,metadata_json)
      VALUES ($1,$2,$3,$4,'homebrew',$5,'published','{}') RETURNING id`,
      [key,type,name,String(form.get('description')||''),userId]);
    const id=created.rows[0].id;
    if(type==='spell') await client.query(`INSERT INTO spell_definitions (content_id,spell_level) VALUES ($1,0)`,[id]);
    if(type==='item') await client.query(`INSERT INTO item_definitions (content_id) VALUES ($1)`,[id]);
    return id;
  });
}

export async function updateAdminContent(form: FormData): Promise<string> {
  const id=String(form.get('contentId')||'');
  return withTransaction(async(client)=>{
    const current=await client.query<{content_type:ContentType}>('SELECT content_type FROM content_definitions WHERE id=$1',[id]);
    if(!current.rowCount) throw new Error('Catalogue entry not found.');
    await client.query(`UPDATE content_definitions SET name=$2,description=$3,publication_status=$4,updated_at=now() WHERE id=$1`,
      [id,String(form.get('name')||'').trim(),String(form.get('description')||''),String(form.get('publicationStatus')||'private')]);
    if(current.rows[0].content_type==='spell') await client.query(`INSERT INTO spell_definitions
      (content_id,spell_level,school,casting_time,spell_range,components,duration,ritual,concentration,classes)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(content_id) DO UPDATE SET
      spell_level=EXCLUDED.spell_level,school=EXCLUDED.school,casting_time=EXCLUDED.casting_time,
      spell_range=EXCLUDED.spell_range,components=EXCLUDED.components,duration=EXCLUDED.duration,
      ritual=EXCLUDED.ritual,concentration=EXCLUDED.concentration,classes=EXCLUDED.classes`,
      [id,Math.min(9,Math.max(0,Number(form.get('spellLevel'))||0)),String(form.get('school')||''),
        String(form.get('castingTime')||''),String(form.get('range')||''),String(form.get('components')||''),
        String(form.get('duration')||''),form.get('ritual')==='on',form.get('concentration')==='on',
        form.getAll('classes').map(value=>String(value).trim()).filter(Boolean)]);
    if(current.rows[0].content_type==='item') await client.query(`INSERT INTO item_definitions
      (content_id,category,equipment_type,requires_attunement,ac_bonus,to_hit_bonus,damage_bonus,attack_ability,damage_rolls)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(content_id) DO UPDATE SET
      category=EXCLUDED.category,equipment_type=EXCLUDED.equipment_type,requires_attunement=EXCLUDED.requires_attunement,
      ac_bonus=EXCLUDED.ac_bonus,to_hit_bonus=EXCLUDED.to_hit_bonus,damage_bonus=EXCLUDED.damage_bonus,
      attack_ability=EXCLUDED.attack_ability,damage_rolls=EXCLUDED.damage_rolls`,
      [id,String(form.get('category')||'gear'),String(form.get('equipmentType')||'item'),form.get('requiresAttunement')==='on',
        Number(form.get('acBonus'))||0,Number(form.get('toHitBonus'))||0,Number(form.get('damageBonus'))||0,
        String(form.get('attackAbility')||'str'),String(form.get('damageRolls')||'')]);
    return id;
  });
}

export async function attachModifierToContent(form: FormData): Promise<string> {
  const contentId=String(form.get('contentId')||'');
  const modifierId=String(form.get('modifierId')||'');
  const activation=String(form.get('activationType')||'manual');
  return withTransaction(async(client)=>{
    const content=await client.query<any>('SELECT content_type,name FROM content_definitions WHERE id=$1',[contentId]);
    if(!content.rowCount||!modifierId) throw new Error('Content and modifier are required.');
    const effectKey=`content_${contentId.replace(/-/g,'')}_${activation}`;
    const effect=await client.query<{id:string}>(`INSERT INTO effect_definitions
      (effect_key,name,source_type,source_ref,description,duration_type,is_selectable,is_homebrew,metadata_json)
      VALUES($1,$2,$3,$4,$5,'while_applicable',false,true,$6)
      ON CONFLICT(effect_key) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
      [effectKey,`${content.rows[0].name} ${activation.replace('_',' ')} Modifiers`,content.rows[0].content_type,`content.${contentId}.${activation}`,
        `${activation.replace('_',' ')} modifiers attached to ${content.rows[0].name}.`,JSON.stringify({managedByContentAdmin:true,activation})]);
    await client.query(`INSERT INTO content_effect_links(content_id,effect_id,activation_type)
      VALUES($1,$2,$3) ON CONFLICT(content_id,effect_id,activation_type) DO NOTHING`,[contentId,effect.rows[0].id,activation]);
    await client.query(`INSERT INTO effect_modifier_links
      (effect_id,modifier_id,value_override_expression,condition_expression,priority)
      VALUES($1,$2,NULLIF($3,''),NULLIF($4,''),$5)
      ON CONFLICT(effect_id,modifier_id,COALESCE(value_override_expression,''),COALESCE(condition_expression,''),priority) DO NOTHING`,
      [effect.rows[0].id,modifierId,String(form.get('valueOverrideExpression')||'').trim(),
        String(form.get('conditionExpression')||'').trim(),Number(form.get('priority'))||0]);
    return contentId;
  });
}

export async function detachContentModifier(form: FormData): Promise<string> {
  const contentId=String(form.get('contentId')||'');
  await query('DELETE FROM effect_modifier_links WHERE id=$1',[String(form.get('linkId')||'')]);
  return contentId;
}

function mapContent(row:any):AdminContentRecord{return{
  id:row.id,type:row.content_type,name:row.name,description:row.description,key:row.content_key,
  sourceKind:row.source_kind,publicationStatus:row.publication_status,spellLevel:row.spell_level,
  school:row.school||'',castingTime:row.casting_time||'',range:row.spell_range||'',components:row.components||'',
  duration:row.duration||'',ritual:Boolean(row.ritual),concentration:Boolean(row.concentration),classes:row.classes||[],
  category:row.category||'gear',equipmentType:row.equipment_type||'item',requiresAttunement:Boolean(row.requires_attunement),
  acBonus:row.ac_bonus||0,toHitBonus:row.to_hit_bonus||0,damageBonus:row.damage_bonus||0,
  attackAbility:row.attack_ability||'str',damageRolls:row.damage_rolls||''};}
