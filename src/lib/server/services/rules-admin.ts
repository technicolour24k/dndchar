import { query, withTransaction } from '$lib/server/db';
import type { ModifierOperation } from '$lib/types/rules';

export const operationRegistry: Array<{ key: ModifierOperation; label: string; value: 'none' | 'number' | 'dice' | 'formula' | 'text' }> = [
  { key: 'bonus', label: 'Bonus', value: 'formula' },
  { key: 'penalty', label: 'Penalty', value: 'formula' },
  { key: 'set', label: 'Set value', value: 'formula' },
  { key: 'multiplier', label: 'Multiplier', value: 'number' },
  { key: 'advantage', label: 'Advantage', value: 'none' },
  { key: 'disadvantage', label: 'Disadvantage', value: 'none' },
  { key: 'extra_die', label: 'Extra die', value: 'dice' },
  { key: 'resistance', label: 'Resistance', value: 'none' },
  { key: 'vulnerability', label: 'Vulnerability', value: 'none' },
  { key: 'immunity', label: 'Immunity', value: 'none' },
  { key: 'grant', label: 'Grant', value: 'text' },
  { key: 'block', label: 'Block', value: 'none' },
  { key: 'condition_apply', label: 'Apply condition', value: 'text' },
  { key: 'condition_remove', label: 'Remove condition', value: 'text' },
  { key: 'formula_override', label: 'Formula override', value: 'formula' }
];

export async function loadRuleHooks(search = '') {
  const result = await query<any>(`SELECT target_key,label,category,value_kind,runtime_supported,description,
    is_archived,is_system,
    EXISTS(SELECT 1 FROM modifier_definitions modifier WHERE modifier.target=modifier_targets.target_key) AS referenced
    FROM modifier_targets WHERE ($1='' OR label ILIKE '%'||$1||'%' OR target_key ILIKE '%'||$1||'%')
    ORDER BY is_archived,label`, [search.trim()]);
  return result.rows.map((row: any) => ({ key: row.target_key, label: row.label, category: row.category,
    valueKind: row.value_kind, runtimeSupported: row.runtime_supported, description: row.description,
    isArchived: row.is_archived, isSystem: row.is_system, referenced: row.referenced }));
}

export async function loadModifiers(search = '') {
  const rows = await query<any>(`SELECT modifier.id,modifier.target,modifier.modifier_type,
    COALESCE(modifier.default_value_expression,'') AS base_value,COALESCE(modifier.label,'') AS label,
    COALESCE(modifier.description,'') AS description,modifier.is_archived,modifier.is_system,
    hook.label AS hook_label,hook.category,hook.value_kind,hook.runtime_supported,
    (SELECT count(*)::int FROM effect_modifier_links WHERE modifier_id=modifier.id) +
    (SELECT count(*)::int FROM content_modifier_links WHERE modifier_id=modifier.id) AS reference_count
    FROM modifier_definitions modifier JOIN modifier_targets hook ON hook.target_key=modifier.target
    WHERE ($1='' OR hook.label ILIKE '%'||$1||'%' OR modifier.target ILIKE '%'||$1||'%'
      OR modifier.modifier_type ILIKE '%'||$1||'%' OR modifier.label ILIKE '%'||$1||'%')
    ORDER BY modifier.is_archived,hook.label,modifier.modifier_type,base_value`, [search.trim()]);

  // Load all references in one query and embed them per modifier.
  const allRefs = await query<any>(`
    SELECT link.modifier_id,'effect' AS owner_type,effect.name,COALESCE(link.value_override_expression,'') AS override_value
    FROM effect_modifier_links link JOIN effect_definitions effect ON effect.id=link.effect_id
    UNION ALL
    SELECT link.modifier_id,'content',content.name,COALESCE(link.value_override_expression,'')
    FROM content_modifier_links link JOIN content_definitions content ON content.id=link.content_id
    ORDER BY name`);
  const refsByModifier = new Map<string,Array<{ownerType:string;name:string;overrideValue:string}>>();
  for(const row of allRefs.rows){
    const list=refsByModifier.get(row.modifier_id)??[];
    list.push({ownerType:row.owner_type,name:row.name,overrideValue:row.override_value});
    refsByModifier.set(row.modifier_id,list);
  }

  return { modifiers: rows.rows.map((row:any)=>({...mapModifier(row),references:refsByModifier.get(row.id)??[]})) };
}

export async function loadEffects(selectedId = '', search = '', showArchived = false) {
  const rows = await query<any>(`SELECT effect.id,effect.effect_key,effect.name,effect.source_type,
    COALESCE(effect.description,'') AS description,COALESCE(effect.duration_type,'variable') AS duration_type,
    effect.duration_rounds,effect.requires_concentration,effect.is_condition,effect.is_selectable,
    effect.stack_behavior,effect.default_expiry_boundary,effect.is_archived,effect.is_system,
    count(modifier_link.id)::int AS modifier_count,
    (SELECT count(*)::int FROM content_effect_links WHERE effect_id=effect.id) AS reference_count
    FROM effect_definitions effect LEFT JOIN effect_modifier_links modifier_link ON modifier_link.effect_id=effect.id
    WHERE COALESCE((effect.metadata_json->>'managedByContentAdmin')::boolean,false)=false
      AND ($1 OR effect.is_archived=false)
      AND ($2='' OR effect.name ILIKE '%'||$2||'%' OR effect.effect_key ILIKE '%'||$2||'%')
    GROUP BY effect.id ORDER BY effect.is_archived,effect.name`, [showArchived, search.trim()]);
  const effects = rows.rows.map((row: any) => ({ id: row.id, key: row.effect_key, name: row.name,
    sourceType: row.source_type, description: row.description, durationType: row.duration_type,
    durationRounds: row.duration_rounds, requiresConcentration: row.requires_concentration,
    isCondition: row.is_condition, isSelectable: row.is_selectable, stackBehavior: row.stack_behavior,
    expiryBoundary: row.default_expiry_boundary, isArchived: row.is_archived, isSystem: row.is_system,
    modifierCount: row.modifier_count, referenceCount: row.reference_count }));
  const id = effects.some((entry: any) => entry.id === selectedId) ? selectedId : effects[0]?.id || '';
  const links = id ? await query<any>(`SELECT link.id,link.modifier_id,hook.label AS hook_label,modifier.target,
    modifier.modifier_type,COALESCE(link.value_override_expression,modifier.default_value_expression,'') AS value_expression,
    COALESCE(link.condition_expression,'') AS condition_expression,link.priority
    FROM effect_modifier_links link JOIN modifier_definitions modifier ON modifier.id=link.modifier_id
    JOIN modifier_targets hook ON hook.target_key=modifier.target WHERE link.effect_id=$1 ORDER BY link.priority,hook.label`, [id]) : { rows: [] };
  return { effects, selectedEffectId: id, effectLinks: links.rows.map((row: any) => ({ id: row.id,
    modifierId: row.modifier_id, hookLabel: row.hook_label, target: row.target, operation: row.modifier_type,
    valueExpression: row.value_expression, condition: row.condition_expression, priority: row.priority })) };
}

export async function createRuleHook(form: FormData) {
  const namespace = cleanToken(form.get('namespace'));
  const qualifier = String(form.get('qualifier') || '').trim().toLowerCase().replace(/[^a-z0-9_.-]+/g, '_').replace(/^\.+|\.+$/g, '');
  const key = [namespace, qualifier].filter(Boolean).join('.');
  const label = String(form.get('label') || '').trim();
  if (!key || !label) throw new Error('A namespace and display name are required.');
  await query(`INSERT INTO modifier_targets(target_key,label,category,value_kind,runtime_supported,description,is_system)
    VALUES($1,$2,$3,$4,false,$5,false)`, [key, label, String(form.get('category') || 'custom'),
    String(form.get('valueKind') || 'formula'), String(form.get('description') || '').trim()]);
  return key;
}

export async function archiveRuleHook(key:string){
  const result=await query(`UPDATE modifier_targets SET is_archived=NOT is_archived,updated_at=now()
    WHERE target_key=$1 AND is_system=false RETURNING target_key`,[key]);
  if(!result.rowCount)throw new Error('System Rule Hooks cannot be archived.');
}

export async function saveModifier(form: FormData, mode: 'create' | 'update' | 'copy') {
  const id = String(form.get('modifierId') || '');
  const target = String(form.get('target') || '');
  const operation = String(form.get('operation') || '') as ModifierOperation;
  const value = validateModifierValue(operation, String(form.get('baseValue') || '').trim());
  const label = String(form.get('label') || '').trim();
  const description = String(form.get('description') || '').trim();
  if (!target || !operationRegistry.some((entry) => entry.key === operation)) throw new Error('Choose a valid Rule Hook and change.');
  if (mode === 'update') {
    if (!id || form.get('confirmShared') !== 'on') throw new Error('Confirm that all references should use the updated Modifier.');
    await query(`UPDATE modifier_definitions SET target=$2,modifier_type=$3,default_value_expression=NULLIF($4,''),
      label=NULLIF($5,''),description=NULLIF($6,''),updated_at=now() WHERE id=$1`, [id,target,operation,value,label,description]);
    return id;
  }
  const result = await query<{id:string}>(`INSERT INTO modifier_definitions
    (target,modifier_type,default_value_expression,label,description,is_system)
    VALUES($1,$2,NULLIF($3,''),NULLIF($4,''),NULLIF($5,''),false)
    ON CONFLICT(target,modifier_type,COALESCE(default_value_expression,'')) DO UPDATE
      SET label=COALESCE(NULLIF(EXCLUDED.label,''),modifier_definitions.label),
          description=COALESCE(NULLIF(EXCLUDED.description,''),modifier_definitions.description)
    RETURNING id`, [target,operation,value,label,description]);
  return result.rows[0].id;
}

export async function archiveModifier(id: string) {
  const result = await query<{is_archived:boolean}>('UPDATE modifier_definitions SET is_archived=NOT is_archived,updated_at=now() WHERE id=$1 RETURNING is_archived',[id]);
  if (!result.rowCount) throw new Error('Modifier not found.');
}

export async function saveEffect(userId: string, form: FormData) {
  const id = String(form.get('effectId') || '');
  const name = String(form.get('name') || '').trim();
  if (!name) throw new Error('Effect name is required.');
  const durationType = String(form.get('durationType')||'variable');
  const description = String(form.get('description')||'');
  const durationRounds = nullableInt(form.get('durationRounds'));
  const requiresConcentration = form.get('requiresConcentration')==='on';
  const stackBehavior = String(form.get('stackBehavior')||'refresh');
  const expiryBoundary = String(form.get('expiryBoundary')||'round_end');
  const values = [name,String(form.get('sourceType')||'homebrew'),description,
    durationType,durationRounds,requiresConcentration,
    form.get('isCondition')==='on',form.get('isSelectable')==='on',stackBehavior,expiryBoundary];
  const mappedDuration = legacyDurationToNew(durationType);

  return withTransaction(async (client) => {
    if (id) {
      await client.query(`UPDATE effect_definitions SET name=$2,source_type=$3,description=$4,duration_type=$5,duration_rounds=$6,
        requires_concentration=$7,is_condition=$8,is_selectable=$9,stack_behavior=$10,default_expiry_boundary=$11,updated_at=now()
        WHERE id=$1`,[id,...values]);
      // Sync to unified Container — use a subquery to resolve effect_key → content_key.
      await client.query(`UPDATE content_definitions SET name=$2,description=$3,duration_type=$4,duration_rounds=$5,
        requires_concentration=$6,stack_behavior=$7,expiry_boundary=$8,updated_at=now()
        WHERE content_key=(SELECT 'condition:'||effect_key FROM effect_definitions WHERE id=$1)
          AND content_type='condition'`,
        [id,name,description,mappedDuration,durationRounds,requiresConcentration,stackBehavior,expiryBoundary]);
      return id;
    }
    const key=`homebrew:${userId}:${slug(name)}:${Date.now()}`;
    const result=await client.query<{id:string}>(`INSERT INTO effect_definitions(effect_key,name,source_type,description,duration_type,
      duration_rounds,requires_concentration,is_condition,is_selectable,stack_behavior,default_expiry_boundary,is_homebrew,
      owner_user_id,is_system) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true,$12,false) RETURNING id`,[key,...values,userId]);
    const effectId = result.rows[0].id;
    await client.query(`INSERT INTO content_definitions(content_key,content_type,name,description,source_kind,
      is_system,is_archived,activation_type,duration_type,duration_rounds,requires_concentration,
      expiry_boundary,stack_behavior) VALUES($1,'condition',$2,$3,'homebrew',false,false,'passive',$4,$5,$6,$7,$8)
      ON CONFLICT DO NOTHING`,
      ['condition:'+key,name,description,mappedDuration,durationRounds,requiresConcentration,expiryBoundary,stackBehavior]);
    return effectId;
  });
}

export async function attachEffectModifier(form: FormData) {
  const effectId=String(form.get('effectId')||'');const modifierId=String(form.get('modifierId')||'');
  if(!effectId||!modifierId)throw new Error('Effect and Modifier are required.');
  const override=String(form.get('valueOverride')||'').trim();
  const condition=String(form.get('condition')||'').trim();
  const priority=Number(form.get('priority'))||0;
  return withTransaction(async (client) => {
    await client.query(`INSERT INTO effect_modifier_links(effect_id,modifier_id,value_override_expression,condition_expression,priority)
      VALUES($1,$2,NULLIF($3,''),NULLIF($4,''),$5) ON CONFLICT DO NOTHING`,[effectId,modifierId,override,condition,priority]);
    // Dual-write: resolve the unified Container id via the effect's key, then insert into content_modifier_links.
    await client.query(`INSERT INTO content_modifier_links(content_id,modifier_id,activation_type,value_override_expression,condition_expression,priority,sort_order)
      SELECT cd.id,$2,'carried',NULLIF($3,''),NULLIF($4,''),$5,$5
      FROM content_definitions cd JOIN effect_definitions ed ON cd.content_key='condition:'||ed.effect_key
      WHERE ed.id=$1 AND cd.content_type='condition'
      ON CONFLICT DO NOTHING`,[effectId,modifierId,override,condition,priority]);
    return effectId;
  });
}

export async function detachEffectModifier(effectId:string,linkId:string){
  await withTransaction(async (client) => {
    // Read link details first so we can match the corresponding content_modifier_links row.
    const link=await client.query<{modifier_id:string;value_override_expression:string|null;condition_expression:string|null;priority:number}>(
      'SELECT modifier_id,value_override_expression,condition_expression,priority FROM effect_modifier_links WHERE id=$1 AND effect_id=$2',
      [linkId,effectId]);
    if(link.rowCount){
      const {modifier_id,value_override_expression,condition_expression,priority}=link.rows[0];
      await client.query(`DELETE FROM content_modifier_links
        WHERE modifier_id=$1
          AND COALESCE(value_override_expression,'')=COALESCE($2::text,'')
          AND COALESCE(condition_expression,'')=COALESCE($3::text,'')
          AND priority=$4
          AND content_id=(SELECT cd.id FROM content_definitions cd
            JOIN effect_definitions ed ON cd.content_key='condition:'||ed.effect_key
            WHERE ed.id=$5 AND cd.content_type='condition' LIMIT 1)`,
        [modifier_id,value_override_expression,condition_expression,priority,effectId]);
    }
    await client.query('DELETE FROM effect_modifier_links WHERE id=$1 AND effect_id=$2',[linkId,effectId]);
  });
}

export async function archiveEffect(id:string){
  const result=await query<{effect_key:string;is_archived:boolean}>(
    'UPDATE effect_definitions SET is_archived=NOT is_archived,updated_at=now() WHERE id=$1 RETURNING effect_key,is_archived',[id]);
  if(!result.rowCount)throw new Error('Effect not found.');
  await query(`UPDATE content_definitions SET is_archived=$1,updated_at=now()
    WHERE content_key=$2 AND content_type='condition'`,
    [result.rows[0].is_archived,'condition:'+result.rows[0].effect_key]);
}

function legacyDurationToNew(d:string):string|null{
  if(d==='concentration')return'concentration';
  if(d==='timed'||d==='until_start_of_next_turn')return'rounds';
  if(d==='variable'||d==='while_applicable')return'indefinite';
  return null;
}

function validateModifierValue(operation:ModifierOperation,value:string){
  const spec=operationRegistry.find((entry)=>entry.key===operation);
  if(!spec)throw new Error('Unknown Modifier change.');
  if(spec.value==='none')return '';
  if(!value)throw new Error('This change requires a value.');
  if(spec.value==='number'&&!/^-?\d+(?:\.\d+)?$/.test(value))throw new Error('Enter a number.');
  if(spec.value==='dice'&&!/^\d*d\d+(?:[+-]\d+)?$/i.test(value.replace(/\s+/g,'')))throw new Error('Enter a dice expression such as 1d4.');
  if(!/^[a-zA-Z0-9_.,+\- ]+$/.test(value))throw new Error('The value contains unsupported characters.');
  return value;
}
function mapModifier(row:any){return{id:row.id,target:row.target,operation:row.modifier_type,baseValue:row.base_value,
  label:row.label,description:row.description,isArchived:row.is_archived,isSystem:row.is_system,
  hookLabel:row.hook_label,category:row.category,valueKind:row.value_kind,runtimeSupported:row.runtime_supported,referenceCount:row.reference_count};}
function cleanToken(value:FormDataEntryValue|null){return String(value||'').trim().toLowerCase().replace(/[^a-z0-9_-]+/g,'_').replace(/^_+|_+$/g,'');}
function slug(value:string){return value.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,'').slice(0,80)||'effect';}
function nullableInt(value:FormDataEntryValue|null){const raw=String(value||'').trim();return raw===''?null:Math.max(0,Number(raw)||0);}
