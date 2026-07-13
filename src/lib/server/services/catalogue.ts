import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { abilityModifier, abilityMap, proficiencyBonus, resolveResourceMaximum, standardSpellSlotMaximums, pactMagicSlots, totalLevel } from '$lib/rules/dnd5e';
import { executeContentActions, type ActionResult } from '$lib/server/services/action-engine';
import type { AbilityKey, CharacterAbility, CharacterClass } from '$lib/types/character';
import type { CharacterContentInstance, ContentDefinition, ContentType, RechargePeriod, SpellSlot } from '$lib/types/content';

const contentTypes = new Set<ContentType>(['item', 'spell', 'feat', 'class_feature', 'condition', 'action']);
const rechargePeriods = new Set<RechargePeriod>(['short_rest', 'long_rest', 'dawn', 'round', 'encounter', 'manual']);

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'content';
}

export async function listCatalogue(userId: string, type?: ContentType, search = ''): Promise<ContentDefinition[]> {
  const result = await query<any>(
    `
      SELECT c.*, s.spell_level, s.school, s.casting_time, s.spell_range, s.components, s.duration,
        s.ritual, s.concentration, s.classes, s.higher_level,
        i.category, i.equipment_type, i.requires_attunement, i.ac_bonus, i.to_hit_bonus,
        i.damage_bonus, i.attack_ability, i.damage_rolls
      FROM content_definitions c
      LEFT JOIN spell_definitions s ON s.content_id = c.id
      LEFT JOIN item_definitions i ON i.content_id = c.id
      WHERE c.is_archived=false AND ($1::text IS NULL OR c.content_type = $1)
        AND ($2 = '' OR c.name ILIKE '%' || $2 || '%')
      ORDER BY c.source_kind = 'srd' DESC, c.name ASC
      LIMIT 300
    `,
    [type || null, search.trim()]
  );

  const ids = result.rows.map((row: any) => row.id);
  const effects = ids.length ? await query<any>(
    `SELECT l.content_id, l.effect_id, e.name, l.activation_type
     FROM content_effect_links l JOIN effect_definitions e ON e.id = l.effect_id
     WHERE l.content_id = ANY($1::uuid[]) ORDER BY l.sort_order, e.name`, [ids]
  ) : { rows: [] };
  const resources = ids.length ? await query<any>(
    `SELECT id, content_id, resource_key, label, max_value_expression, recharge_period
     FROM content_resource_definitions WHERE content_id = ANY($1::uuid[]) ORDER BY label`, [ids]
  ) : { rows: [] };

  return result.rows.map((row: any) => ({
    id: row.id,
    key: row.content_key,
    type: row.content_type,
    name: row.name,
    description: row.description,
    sourceKind: row.source_kind,
    sourceRef: row.source_ref || '',
    ownerUserId: row.owner_user_id,
    isArchived: row.is_archived,
    isSystem: row.is_system ?? false,
    metadata: row.metadata_json || {},
    activationType: row.activation_type ?? 'passive',
    costJson: row.cost_json ?? null,
    durationData: {
      type: row.duration_type ?? null,
      rounds: row.duration_rounds ?? null,
      requiresConcentration: row.requires_concentration ?? false,
      expiryBoundary: row.expiry_boundary ?? null,
      stackBehavior: row.stack_behavior ?? 'stack'
    },
    spell: row.content_type === 'spell' ? {
      level: row.spell_level, school: row.school, castingTime: row.casting_time, range: row.spell_range,
      components: row.components, duration: row.duration, ritual: row.ritual, concentration: row.concentration,
      classes: row.classes || [], higherLevel: row.higher_level
    } : undefined,
    item: row.content_type === 'item' ? {
      category: row.category, equipmentType: row.equipment_type, requiresAttunement: row.requires_attunement,
      acBonus: row.ac_bonus, toHitBonus: row.to_hit_bonus, damageBonus: row.damage_bonus,
      attackAbility: row.attack_ability as AbilityKey, damageRolls: row.damage_rolls
    } : undefined,
    effects: effects.rows.filter((link: any) => link.content_id === row.id).map((link: any) => ({
      effectId: link.effect_id, effectName: link.name, activationType: link.activation_type
    })),
    resources: resources.rows.filter((resource: any) => resource.content_id === row.id).map((resource: any) => ({
      id: resource.id, key: resource.resource_key, label: resource.label,
      maxValueExpression: resource.max_value_expression, rechargePeriod: resource.recharge_period
    }))
  }));
}

export async function createHomebrewContent(userId: string, form: FormData): Promise<string> {
  const type = String(form.get('contentType') || '') as ContentType;
  const name = String(form.get('name') || '').trim();
  if (!contentTypes.has(type) || !name) throw new Error('A valid content type and name are required.');

  return withTransaction(async (client) => {
    const key = `custom:${userId}:${type}:${slug(name)}:${Date.now()}`;
    const created = await client.query<{ id: string }>(
      `INSERT INTO content_definitions
       (content_key, content_type, name, description, source_kind, owner_user_id, metadata_json)
       VALUES ($1, $2, $3, $4, 'homebrew', $5, $6) RETURNING id`,
      [key, type, name, String(form.get('description') || ''), userId, JSON.stringify({})]
    );
    const id = created.rows[0].id;
    if (type === 'spell') {
      await client.query(
        `INSERT INTO spell_definitions
         (content_id, spell_level, school, casting_time, spell_range, components, duration, ritual, concentration, classes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [id, Math.min(9, Math.max(0, Number(form.get('spellLevel')) || 0)), String(form.get('school') || ''),
          String(form.get('castingTime') || ''), String(form.get('range') || ''), String(form.get('components') || ''),
          String(form.get('duration') || ''), form.get('ritual') === 'on', form.get('concentration') === 'on',
          String(form.get('classes') || '').split(',').map((value) => value.trim()).filter(Boolean)]
      );
    }
    if (type === 'item') {
      await client.query(
        `INSERT INTO item_definitions
         (content_id, category, equipment_type, requires_attunement, ac_bonus, to_hit_bonus, damage_bonus, attack_ability, damage_rolls)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [id, String(form.get('category') || 'gear'), String(form.get('equipmentType') || 'item'),
          form.get('requiresAttunement') === 'on', Number(form.get('acBonus')) || 0, Number(form.get('toHitBonus')) || 0,
          Number(form.get('damageBonus')) || 0, String(form.get('attackAbility') || 'str'), String(form.get('damageRolls') || '')]
      );
    }
    return id;
  });
}

export async function setContentArchived(userId:string,contentId:string,isAdmin=false):Promise<void>{
  const result=await query(`UPDATE content_definitions SET is_archived=NOT is_archived,updated_at=now()
    WHERE id=$1 AND ($2::boolean OR owner_user_id=$3) RETURNING id`,[contentId,isAdmin,userId]);
  if(!result.rowCount)throw new Error('Catalogue entry not found or not editable.');
}

export async function updateOwnedContent(userId:string,form:FormData):Promise<void>{
  const result=await query(`UPDATE content_definitions SET name=$3,description=$4,updated_at=now()
    WHERE id=$1 AND owner_user_id=$2 AND source_kind='homebrew'`,[String(form.get('contentId')||''),userId,
    String(form.get('name')||'').trim(),String(form.get('description')||'').trim()]);
  if(!result.rowCount)throw new Error('Homebrew entry not found or not editable.');
}

export async function attachEffectToContent(form: FormData): Promise<void> {
  const contentId = String(form.get('contentId') || '');
  const effectId = String(form.get('effectId') || '');
  const activationType = String(form.get('activationType') || 'manual');
  // Legacy write: keep content_effect_links for backward compat during transition.
  await query(`INSERT INTO content_effect_links (content_id, effect_id, activation_type)
    VALUES ($1,$2,$3) ON CONFLICT (content_id, effect_id, activation_type) DO NOTHING`,
    [contentId, effectId, activationType]);
  // Unified Container write: insert into content_grants pointing at the condition Container.
  await query(`INSERT INTO content_grants (source_content_id, granted_content_id, activation_type)
    SELECT $1, cd.id, $3
    FROM content_definitions cd
    JOIN effect_definitions ed ON cd.content_key='condition:'||ed.effect_key
    WHERE ed.id=$2 AND cd.content_type='condition'
    ON CONFLICT DO NOTHING`,
    [contentId, effectId, activationType]);
}

export async function attachEffectToOwnedContent(userId: string, form: FormData): Promise<void> {
  const contentId = String(form.get('contentId') || '');
  const owned = await query('SELECT id FROM content_definitions WHERE id=$1 AND owner_user_id=$2', [contentId, userId]);
  if (!owned.rowCount) throw new Error('Private homebrew content not found.');
  if (String(form.get('activationType') || 'manual') === 'on_use') {
    await withTransaction(async (client) => {
      const content = await client.query<any>('SELECT name, owner_user_id FROM content_definitions WHERE id=$1', [contentId]);
      const actionKey = `content:${contentId}:on_use`;
      const actionName = `Use ${content.rows[0].name}`;
      const actionDesc = `Actions for ${content.rows[0].name}`;
      // Legacy write: action_definitions.
      const action = await client.query<{ id: string }>(`INSERT INTO action_definitions(action_key,name,description,owner_user_id)
        VALUES($1,$2,$3,$4) ON CONFLICT(action_key) DO UPDATE SET name=EXCLUDED.name RETURNING id`,
        [actionKey, actionName, actionDesc, content.rows[0].owner_user_id]);
      // Unified Container write: content_definitions as type='action'.
      const actionContainer = await client.query<{ id: string }>(`INSERT INTO content_definitions(content_key,content_type,name,description,source_kind,owner_user_id,activation_type)
        VALUES($1,'action',$2,$3,'homebrew',$4,'active_use')
        ON CONFLICT DO NOTHING RETURNING id`,
        [actionKey, actionName, actionDesc, content.rows[0].owner_user_id]);
      const actionContainerId = actionContainer.rows[0]?.id ?? null;
      // Link action to content (legacy action_id path + new action_container_id path).
      await client.query(`INSERT INTO content_action_links(content_id,action_id,action_container_id,trigger_type)
        VALUES($1,$2,$3,'on_use') ON CONFLICT(content_id,action_id,trigger_type) DO UPDATE SET action_container_id=EXCLUDED.action_container_id`,
        [contentId, action.rows[0].id, actionContainerId]);
      const effectId = String(form.get('effectId') || '');
      // Legacy action_steps write.
      await client.query(`INSERT INTO action_steps(action_id,container_id,step_type,operation,effect_id,label,sort_order)
        SELECT $1,$5,'apply_effect','apply',$2,effect.name,
          COALESCE((SELECT max(sort_order)+1 FROM action_steps WHERE action_id=$1),0)
        FROM effect_definitions effect WHERE effect.id=$2
          AND NOT EXISTS(SELECT 1 FROM action_steps WHERE action_id=$1 AND step_type='apply_effect' AND effect_id=$2)`,
        [action.rows[0].id, effectId, null, null, actionContainerId]);
    });
    return;
  }
  await attachEffectToContent(form);
}

export async function addContentResourceDefinition(form: FormData): Promise<void> {
  const contentId = String(form.get('contentId') || '');
  const key = String(form.get('resourceKey') || '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  const label = String(form.get('resourceLabel') || '').trim();
  const recharge = String(form.get('rechargePeriod') || 'manual');
  if (!contentId || !key || !label || !isValidRechargePeriod(recharge)) throw new Error('Valid resource details are required.');
  await withTransaction(async (client) => {
    await client.query(`INSERT INTO content_resource_definitions
      (content_id, resource_key, label, max_value_expression, recharge_period) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (content_id, resource_key) DO UPDATE SET label=EXCLUDED.label,
        max_value_expression=EXCLUDED.max_value_expression, recharge_period=EXCLUDED.recharge_period`,
      [contentId, key, label, String(form.get('maxValueExpression') || '1'), recharge]);
    const instances = await client.query<{ id: string; character_id: string }>(
      'SELECT id, character_id FROM character_content_instances WHERE content_id=$1', [contentId]);
    for (const instance of instances.rows) await initializeContentResources(client, instance.id, instance.character_id);
    const inventory=await client.query<{id:string;character_id:string}>('SELECT id,character_id FROM character_inventory_items WHERE source_content_id=$1',[contentId]);
    for(const item of inventory.rows)await initializeInventoryResources(client,item.id,item.character_id,contentId);
  });
}

export async function grantContentFromContent(form: FormData): Promise<void> {
  await query(`INSERT INTO content_grants (source_content_id, granted_content_id, activation_type)
    VALUES ($1,$2,$3) ON CONFLICT (source_content_id, granted_content_id, activation_type) DO NOTHING`,
    [String(form.get('sourceContentId') || ''), String(form.get('grantedContentId') || ''), String(form.get('activationType') || 'equipped')]);
}

export async function addOwnedContentResourceDefinition(userId: string, form: FormData): Promise<void> {
  const contentId = String(form.get('contentId') || '');
  const owned = await query('SELECT id FROM content_definitions WHERE id=$1 AND owner_user_id=$2', [contentId, userId]);
  if (!owned.rowCount) throw new Error('Private homebrew content not found.');
  await addContentResourceDefinition(form);
}

export async function listEffectsForLinking(userId?: string): Promise<Array<{ id: string; name: string }>> {
  const result = await query<{ id: string; name: string }>(`SELECT id, name FROM effect_definitions
    WHERE is_archived=false ORDER BY name`);
  return result.rows;
}

export async function addContentToCharacter(userId: string, characterId: string, contentId: string): Promise<void> {
  await withTransaction(async (client) => {
    await assertCharacterOwner(client, userId, characterId);
    const visible = await client.query('SELECT id FROM content_definitions WHERE id=$1 AND is_archived=false', [contentId]);
    if (!visible.rowCount) throw new Error('Catalogue entry not found.');
    const definition = await client.query<any>(`SELECT c.content_type, c.name, i.* FROM content_definitions c
      LEFT JOIN item_definitions i ON i.content_id = c.id WHERE c.id = $1`, [contentId]);
    if (definition.rows[0]?.content_type === 'item') {
      const item = definition.rows[0];
      const inventory=await client.query<{id:string}>(`INSERT INTO character_inventory_items
        (character_id, name, category, quantity, equipped, location, is_equipment, ac_bonus, to_hit_bonus,
         damage_bonus, attack_ability, damage_rolls, source_content_id, attuned, notes, sort_order)
        VALUES ($1,$2,$3,1,false,'backpack',($3 IN ('weapon','armor','shield','focus')),$4,$5,$6,$7,$8,$9,false,'',
          COALESCE((SELECT max(sort_order)+1 FROM character_inventory_items WHERE character_id=$1),0)) RETURNING id`,
        [characterId, item.name, item.category || 'gear', item.ac_bonus || 0, item.to_hit_bonus || 0,
          item.damage_bonus || 0, item.attack_ability || 'str', item.damage_rolls || '', contentId]);
      await initializeInventoryResources(client,inventory.rows[0].id,characterId,contentId);
      return;
    }
    const instance = await client.query<{ id: string }>(
      `INSERT INTO character_content_instances (character_id, content_id, is_prepared, is_active)
       SELECT $1, id, content_type <> 'spell', content_type <> 'spell' FROM content_definitions WHERE id = $2
       ON CONFLICT (character_id, content_id) DO UPDATE SET is_active = true RETURNING id`, [characterId, contentId]
    );
    await initializeContentResources(client, instance.rows[0].id, characterId);
    await syncSpellSlotsWithClient(client, characterId);
  });
}

export async function removeContentFromCharacter(userId: string, characterId: string, instanceId: string): Promise<void> {
  const result = await query(`DELETE FROM character_content_instances USING characters
    WHERE character_content_instances.id = $1 AND character_content_instances.character_id = $2
      AND characters.id = character_content_instances.character_id AND characters.owner_user_id = $3`,
    [instanceId, characterId, userId]);
  if (!result.rowCount) throw new Error('Character content not found.');
}

export async function setCharacterContentState(userId: string, characterId: string, instanceId: string, form: FormData): Promise<void> {
  const result = await query(`UPDATE character_content_instances i SET
      is_known = $1, is_prepared = $2, is_active = $3, notes = $4
    FROM characters c WHERE i.id = $5 AND i.character_id = $6 AND c.id = i.character_id AND c.owner_user_id = $7`,
    [form.get('isKnown') === 'true', form.get('isPrepared') === 'true', form.get('isActive') === 'true',
      String(form.get('notes') || ''), instanceId, characterId, userId]);
  if (!result.rowCount) throw new Error('Character content not found.');
  await syncCharacterSpellSlots(userId, characterId);
}

export async function useContentResource(userId: string, characterId: string, resourceId: string, delta: number): Promise<void> {
  await withTransaction(async (client) => {
    const result = await client.query<{ character_content_id: string; content_id: string }>(`UPDATE character_content_resources r SET current_value = GREATEST(0, LEAST(max_value, current_value + $1))
      FROM character_content_instances i, characters c
      WHERE r.id = $2 AND i.id = r.character_content_id AND i.character_id = $3
        AND c.id = i.character_id AND c.owner_user_id = $4
      RETURNING r.character_content_id, i.content_id`, [delta, resourceId, characterId, userId]);
    if (!result.rowCount) throw new Error('Resource not found.');
    if(delta<0)await executeContentActions(client,characterId,result.rows[0].content_id,['on_use'],{instanceId:result.rows[0].character_content_id});
  });
}

export async function useInventoryResource(userId:string,characterId:string,resourceId:string,delta:number):Promise<void>{
  const result=await query(`UPDATE character_inventory_resources resource SET current_value=GREATEST(0,LEAST(max_value,current_value+$1))
    FROM character_inventory_items inventory,characters character WHERE resource.id=$2 AND inventory.id=resource.inventory_item_id
      AND inventory.character_id=$3 AND character.id=inventory.character_id AND character.owner_user_id=$4`,[delta,resourceId,characterId,userId]);
  if(!result.rowCount)throw new Error('Item resource not found.');
}

export async function listCharacterContent(characterId: string): Promise<CharacterContentInstance[]> {
  const result = await query<any>(`SELECT i.*, c.content_type, c.name, c.description, s.spell_level,
    EXISTS(SELECT 1 FROM content_action_links action WHERE action.content_id=c.id) AS has_resource_actions
    FROM character_content_instances i JOIN content_definitions c ON c.id = i.content_id
    LEFT JOIN spell_definitions s ON s.content_id = c.id WHERE i.character_id = $1
    ORDER BY c.content_type, c.name`, [characterId]);
  const resources = await query<any>(`SELECT r.*, d.resource_key, d.label, d.max_value_expression, d.recharge_period
    FROM character_content_resources r JOIN content_resource_definitions d ON d.id = r.resource_definition_id
    JOIN character_content_instances i ON i.id = r.character_content_id WHERE i.character_id = $1`, [characterId]);
  const instances: CharacterContentInstance[] = result.rows.map((row: any) => ({
    id: row.id, contentId: row.content_id, type: row.content_type, name: row.custom_name || row.name,
    description: row.description, isKnown: row.is_known, isPrepared: row.is_prepared, isActive: row.is_active,
    notes: row.notes, spellLevel: row.spell_level, hasResourceActions: row.has_resource_actions,
    resources: resources.rows.filter((resource: any) => resource.character_content_id === row.id).map((resource: any) => ({
      id: resource.id, key: resource.resource_key, label: resource.label, maxValueExpression: resource.max_value_expression,
      rechargePeriod: resource.recharge_period, currentValue: resource.current_value, maxValue: resource.max_value
    }))
  }));
  const grants = await query<any>(`SELECT g.id, granted.id AS content_id, granted.content_type, granted.name,
      granted.description, source.name AS source_name
    FROM character_inventory_items inventory
    JOIN content_grants g ON g.source_content_id = inventory.source_content_id
    JOIN content_definitions granted ON granted.id = g.granted_content_id
    JOIN content_definitions source ON source.id = g.source_content_id
    WHERE inventory.character_id = $1 AND (g.activation_type='carried'
      OR (g.activation_type='equipped' AND inventory.equipped)
      OR (g.activation_type='attuned' AND inventory.attuned))`, [characterId]);
  const spellAccess=await query<any>(`SELECT access.id,access.spell_content_id,spell.name,spell.description,spell_detail.spell_level,
      inventory.id AS inventory_id,inventory.name AS source_name FROM character_inventory_items inventory
    JOIN content_spell_access access ON access.owner_content_id=inventory.source_content_id
    JOIN content_definitions spell ON spell.id=access.spell_content_id
    JOIN spell_definitions spell_detail ON spell_detail.content_id=spell.id
    WHERE inventory.character_id=$1 AND (access.availability_type='carried'
      OR (access.availability_type='equipped' AND inventory.equipped)
      OR (access.availability_type='attuned' AND inventory.attuned))`,[characterId]);
  return [...instances, ...grants.rows.map((row: any): CharacterContentInstance => ({
    id: `grant:${row.id}`, contentId: row.content_id, type: row.content_type, name: row.name,
    description: row.description, isKnown: true, isPrepared: true, isActive: true, notes: '',
    spellLevel: null, grantedBy: row.source_name, resources: []
  })),...spellAccess.rows.map((row:any):CharacterContentInstance=>({id:`spell-access:${row.id}:${row.inventory_id}`,
    contentId:row.spell_content_id,type:'spell',name:row.name,description:row.description,isKnown:true,isPrepared:true,isActive:true,
    notes:'',spellLevel:row.spell_level,grantedBy:row.source_name,spellAccessId:row.id,inventoryItemId:row.inventory_id,resources:[]}))];
}

export async function castCharacterSpell(userId:string,characterId:string,form:FormData):Promise<ActionResult[]>{
  return withTransaction(async(client)=>{await assertCharacterOwner(client,userId,characterId);
    const accessId=String(form.get('spellAccessId')||'');let spellId='';let instanceId:string|undefined;
    if(accessId){
      const inventoryId=String(form.get('inventoryItemId')||'');
      const access=await client.query<any>(`SELECT access.*,spell.spell_level FROM content_spell_access access
        JOIN spell_definitions spell ON spell.content_id=access.spell_content_id
        JOIN character_inventory_items inventory ON inventory.source_content_id=access.owner_content_id
        WHERE access.id=$1 AND inventory.id=$2 AND inventory.character_id=$3 AND (access.availability_type='carried'
          OR (access.availability_type='equipped' AND inventory.equipped) OR (access.availability_type='attuned' AND inventory.attuned)) FOR UPDATE`,[accessId,inventoryId,characterId]);
      if(!access.rowCount)throw new Error('Granted Spell is unavailable.');const row=access.rows[0];spellId=row.spell_content_id;
      const cost=Math.max(1,Number(row.resource_cost_expression)||1);
      if(row.access_type==='charges'||row.access_type==='limited_free'){
        if(!row.resource_definition_id)throw new Error('This Spell access has no charge resource.');
        const spent=await client.query(`UPDATE character_inventory_resources SET current_value=current_value-$3
          WHERE inventory_item_id=$1 AND resource_definition_id=$2 AND current_value>=$3`,[inventoryId,row.resource_definition_id,cost]);
        if(!spent.rowCount)throw new Error('Not enough charges to cast this Spell.');
      }else if(row.access_type==='character_slots'&&row.spell_level>0)await spendAvailableSlot(client,characterId,row.spell_level,form);
      return executeContentActions(client,characterId,spellId,['on_cast','on_use'],{inventoryId});
    }
    instanceId=String(form.get('instanceId')||'');const spell=await client.query<any>(`SELECT instance.content_id,instance.is_known,instance.is_prepared,definition.spell_level
      FROM character_content_instances instance JOIN spell_definitions definition ON definition.content_id=instance.content_id
      WHERE instance.id=$1 AND instance.character_id=$2 FOR UPDATE`,[instanceId,characterId]);
    if(!spell.rowCount||!spell.rows[0].is_known||!spell.rows[0].is_prepared)throw new Error('Spell must be known and prepared before casting.');
    spellId=spell.rows[0].content_id;if(spell.rows[0].spell_level>0)await spendAvailableSlot(client,characterId,spell.rows[0].spell_level,form);
    return executeContentActions(client,characterId,spellId,['on_cast','on_use'],{instanceId});
  });
}

async function spendAvailableSlot(client:pg.PoolClient,characterId:string,minimumLevel:number,form:FormData){
  const requestedType=String(form.get('slotType')||''),requestedLevel=Number(form.get('slotLevel'))||0;
  const slot=await client.query<any>(`SELECT slot_type,slot_level FROM character_spell_slots WHERE character_id=$1 AND current_slots>0
    AND slot_level>=$2 AND ($3='' OR slot_type=$3) AND ($4=0 OR slot_level=$4) ORDER BY slot_level,slot_type='pact' LIMIT 1 FOR UPDATE`,[characterId,minimumLevel,requestedType,requestedLevel]);
  if(!slot.rowCount)throw new Error('No suitable Spell slot is available.');await client.query(`UPDATE character_spell_slots SET current_slots=current_slots-1
    WHERE character_id=$1 AND slot_type=$2 AND slot_level=$3`,[characterId,slot.rows[0].slot_type,slot.rows[0].slot_level]);
}

export async function listSpellSlots(characterId: string): Promise<SpellSlot[]> {
  const result = await query<any>('SELECT slot_type, slot_level, current_slots, max_slots FROM character_spell_slots WHERE character_id = $1 ORDER BY slot_type, slot_level', [characterId]);
  return result.rows.map((row: any) => ({ type: row.slot_type, level: row.slot_level, current: row.current_slots, max: row.max_slots }));
}

export async function syncCharacterSpellSlots(userId: string, characterId: string): Promise<void> {
  await withTransaction(async (client) => {
    await assertCharacterOwner(client, userId, characterId);
    await syncSpellSlotsWithClient(client, characterId);
  });
}

export async function spendSpellSlot(userId: string, characterId: string, type: 'standard' | 'pact', level: number, delta: number): Promise<void> {
  const result = await query(`UPDATE character_spell_slots s SET current_slots = GREATEST(0, LEAST(max_slots, current_slots + $1))
    FROM characters c WHERE s.character_id = $2 AND s.slot_type = $3 AND s.slot_level = $4
      AND c.id = s.character_id AND c.owner_user_id = $5`, [delta, characterId, type, level, userId]);
  if (!result.rowCount) throw new Error('Spell slot not found.');
}

export type ResourceActionResult=ActionResult;

export async function useInventoryCatalogueItem(userId: string, characterId: string, inventoryId: string): Promise<ResourceActionResult[]> {
  return withTransaction(async (client) => {
    await assertCharacterOwner(client, userId, characterId);
    const item = await client.query<any>(`SELECT source_content_id,quantity FROM character_inventory_items
      WHERE id=$1 AND character_id=$2 AND quantity>0 FOR UPDATE`, [inventoryId, characterId]);
    if (!item.rowCount) throw new Error('Inventory item is unavailable.');
    if (!item.rows[0].source_content_id) return [];
    const hasSpendStep=await client.query(`SELECT 1 FROM content_action_links link JOIN action_steps step ON step.action_id=link.action_id
      WHERE link.content_id=$1 AND link.trigger_type='on_use' AND step.step_type='spend_item' LIMIT 1`,[item.rows[0].source_content_id]);
    if(!hasSpendStep.rowCount)await client.query('UPDATE character_inventory_items SET quantity=quantity-1 WHERE id=$1',[inventoryId]);
    const results=await executeContentActions(client,characterId,item.rows[0].source_content_id,['on_use'],{inventoryId});
    return results;
  });
}

export async function triggerCharacterContentActions(userId:string,characterId:string,instanceId:string):Promise<ResourceActionResult[]>{
  return withTransaction(async(client)=>{
    await assertCharacterOwner(client,userId,characterId);
    const instance=await client.query<{content_id:string}>(`SELECT content_id FROM character_content_instances
      WHERE id=$1 AND character_id=$2`,[instanceId,characterId]);
    if(!instance.rowCount)throw new Error('Character content not found.');
    return executeContentActions(client,characterId,instance.rows[0].content_id,['manual','on_use'],{instanceId});
  });
}

export async function restCharacter(userId: string, characterId: string, rest: 'short_rest' | 'long_rest'): Promise<void> {
  await withTransaction(async (client) => {
    await assertCharacterOwner(client, userId, characterId);
    const periods = rest === 'long_rest' ? ['short_rest', 'long_rest'] : ['short_rest'];
    await client.query(`UPDATE character_content_resources r SET current_value = max_value
      FROM content_resource_definitions d, character_content_instances i
      WHERE r.resource_definition_id = d.id AND r.character_content_id = i.id
        AND i.character_id = $1 AND d.recharge_period = ANY($2::text[])`, [characterId, periods]);
    await client.query(`UPDATE character_spell_slots SET current_slots = max_slots
      WHERE character_id = $1 AND (slot_type = 'pact' OR $2 = 'long_rest')`, [characterId, rest]);
    await client.query(`UPDATE character_inventory_resources resource SET current_value=resource.max_value
      FROM content_resource_definitions definition,character_inventory_items inventory
      WHERE resource.resource_definition_id=definition.id AND resource.inventory_item_id=inventory.id
        AND inventory.character_id=$1 AND definition.recharge_period=ANY($2::text[])`,[characterId,periods]);
  });
}

export async function getCombatClock(characterId: string): Promise<{ roundNumber: number; turnNumber: number }> {
  const result = await query<any>(`INSERT INTO character_combat_clocks (character_id) VALUES ($1)
    ON CONFLICT (character_id) DO UPDATE SET character_id = EXCLUDED.character_id
    RETURNING round_number, turn_number`, [characterId]);
  return { roundNumber: result.rows[0].round_number, turnNumber: result.rows[0].turn_number };
}

export async function advanceCharacterRound(userId: string, characterId: string): Promise<void> {
  await withTransaction(async (client) => {
    await assertCharacterOwner(client, userId, characterId);
    await client.query(`INSERT INTO character_combat_clocks (character_id, round_number, turn_number) VALUES ($1, 2, 1)
      ON CONFLICT (character_id) DO UPDATE SET round_number = character_combat_clocks.round_number + 1,
        turn_number = 1, updated_at = now()`, [characterId]);
    await client.query(`UPDATE active_character_effects SET remaining_rounds = GREATEST(0, remaining_rounds - 1)
      WHERE character_id = $1 AND remaining_rounds IS NOT NULL AND expiry_boundary = 'round_end'`, [characterId]);
    await client.query(`DELETE FROM active_character_effects WHERE character_id = $1 AND remaining_rounds = 0`, [characterId]);
    await client.query(`UPDATE character_content_resources r SET current_value = max_value
      FROM content_resource_definitions d, character_content_instances i WHERE r.resource_definition_id = d.id
      AND r.character_content_id = i.id AND i.character_id = $1 AND d.recharge_period = 'round'`, [characterId]);
  });
}

export async function advanceCharacterTurn(userId: string, characterId: string): Promise<void> {
  await withTransaction(async (client) => {
    await assertCharacterOwner(client, userId, characterId);
    await client.query(`INSERT INTO character_combat_clocks (character_id, round_number, turn_number) VALUES ($1,1,2)
      ON CONFLICT (character_id) DO UPDATE SET turn_number=character_combat_clocks.turn_number+1, updated_at=now()`, [characterId]);
    await client.query(`UPDATE active_character_effects SET remaining_rounds=GREATEST(0,remaining_rounds-1)
      WHERE character_id=$1 AND remaining_rounds IS NOT NULL AND expiry_boundary IN ('turn_start','turn_end')`, [characterId]);
    await client.query('DELETE FROM active_character_effects WHERE character_id=$1 AND remaining_rounds=0', [characterId]);
  });
}

async function assertCharacterOwner(client: pg.PoolClient, userId: string, characterId: string): Promise<void> {
  const owned = await client.query('SELECT id FROM characters WHERE id = $1 AND owner_user_id = $2', [characterId, userId]);
  if (!owned.rowCount) throw new Error('Character not found.');
}

async function initializeContentResources(client: pg.PoolClient, instanceId: string, characterId: string): Promise<void> {
  const classes = await getClasses(client, characterId);
  const abilities = await getAbilities(client, characterId);
  const level = totalLevel(classes);
  const maxAbility = Math.max(...Object.values(abilityMap(abilities)).map(abilityModifier));
  const definitions = await client.query<any>(`SELECT d.* FROM content_resource_definitions d
    JOIN character_content_instances i ON i.content_id = d.content_id WHERE i.id = $1`, [instanceId]);
  for (const definition of definitions.rows) {
    const maximum = resolveResourceMaximum(definition.max_value_expression, {
      level, proficiencyBonus: proficiencyBonus(level), abilityModifier: maxAbility
    });
    await client.query(`INSERT INTO character_content_resources
      (character_content_id, resource_definition_id, current_value, max_value) VALUES ($1,$2,$3,$3)
      ON CONFLICT (character_content_id, resource_definition_id) DO UPDATE SET max_value = EXCLUDED.max_value,
        current_value = LEAST(character_content_resources.current_value, EXCLUDED.max_value)`, [instanceId, definition.id, maximum]);
  }
}

async function initializeInventoryResources(client:pg.PoolClient,inventoryId:string,characterId:string,contentId:string):Promise<void>{
  const classes=await getClasses(client,characterId);const abilities=await getAbilities(client,characterId);const level=totalLevel(classes);
  const maxAbility=Math.max(...Object.values(abilityMap(abilities)).map(abilityModifier));
  const definitions=await client.query<any>('SELECT * FROM content_resource_definitions WHERE content_id=$1',[contentId]);
  for(const definition of definitions.rows){const maximum=resolveResourceMaximum(definition.max_value_expression,{level,proficiencyBonus:proficiencyBonus(level),abilityModifier:maxAbility});
    await client.query(`INSERT INTO character_inventory_resources(inventory_item_id,resource_definition_id,current_value,max_value)
      VALUES($1,$2,$3,$3) ON CONFLICT(inventory_item_id,resource_definition_id) DO UPDATE SET max_value=EXCLUDED.max_value,
      current_value=LEAST(character_inventory_resources.current_value,EXCLUDED.max_value)`,[inventoryId,definition.id,maximum]);}
}

async function syncSpellSlotsWithClient(client: pg.PoolClient, characterId: string): Promise<void> {
  const classes = await getClasses(client, characterId);
  const standard = standardSpellSlotMaximums(classes);
  const bonusResult = await client.query<{ bonus: string }>(`WITH effect_ids AS (
      SELECT effect_id FROM active_character_effects WHERE character_id=$1
      UNION SELECT l.effect_id FROM character_content_instances i
        JOIN content_effect_links l ON l.content_id=i.content_id
        WHERE i.character_id=$1 AND i.is_active AND l.activation_type IN ('manual','carried','equipped','attuned')
      UNION SELECT l.effect_id FROM character_inventory_items inventory
        JOIN content_effect_links l ON l.content_id=inventory.source_content_id
        WHERE inventory.character_id=$1 AND (l.activation_type='carried'
          OR (l.activation_type='equipped' AND inventory.equipped)
          OR (l.activation_type='attuned' AND inventory.attuned))
    ), modifier_values AS (
      SELECT COALESCE(l.value_override_expression,m.default_value_expression,'') AS value_expression,m.target,m.modifier_type
      FROM effect_ids active JOIN effect_modifier_links l ON l.effect_id=active.effect_id
      JOIN modifier_definitions m ON m.id=l.modifier_id
      UNION ALL
      SELECT COALESCE(l.value_override_expression,m.default_value_expression,''),m.target,m.modifier_type
      FROM character_content_instances instance JOIN content_modifier_links l ON l.content_id=instance.content_id
      JOIN modifier_definitions m ON m.id=l.modifier_id WHERE instance.character_id=$1 AND instance.is_active
        AND (l.activation_type='manual' OR (l.activation_type='known' AND instance.is_known)
          OR (l.activation_type='prepared' AND instance.is_prepared))
      UNION ALL
      SELECT COALESCE(l.value_override_expression,m.default_value_expression,''),m.target,m.modifier_type
      FROM character_inventory_items inventory JOIN content_modifier_links l ON l.content_id=inventory.source_content_id
      JOIN modifier_definitions m ON m.id=l.modifier_id WHERE inventory.character_id=$1
        AND (l.activation_type='carried' OR (l.activation_type='equipped' AND inventory.equipped)
          OR (l.activation_type='attuned' AND inventory.attuned))
    ) SELECT COALESCE(sum(CASE WHEN value_expression ~ '^-?[0-9]+$' THEN value_expression::integer ELSE 0 END),0)::text AS bonus
    FROM modifier_values WHERE target='spell_slots.highest.max' AND modifier_type='bonus'`, [characterId]);
  const highestIndex = standard.findLastIndex((maximum) => maximum > 0);
  if (highestIndex >= 0) standard[highestIndex] = Math.max(0, standard[highestIndex] + (Number(bonusResult.rows[0]?.bonus) || 0));
  await client.query(`DELETE FROM character_spell_slots WHERE character_id = $1 AND slot_type = 'standard'
    AND NOT (slot_level = ANY($2::int[]))`, [characterId, standard.map((value, index) => value ? index + 1 : 0).filter(Boolean)]);
  for (let index = 0; index < standard.length; index += 1) {
    const maximum = standard[index];
    if (!maximum) continue;
    await upsertSlot(client, characterId, 'standard', index + 1, maximum);
  }
  const pact = pactMagicSlots(classes);
  await client.query(`DELETE FROM character_spell_slots WHERE character_id=$1 AND slot_type='pact'
    AND ($2::int=0 OR slot_level<>$2)`, [characterId, pact.level]);
  if (pact.slots) await upsertSlot(client, characterId, 'pact', pact.level, pact.slots);
}

async function upsertSlot(client: pg.PoolClient, characterId: string, type: string, level: number, maximum: number): Promise<void> {
  await client.query(`INSERT INTO character_spell_slots (character_id, slot_type, slot_level, current_slots, max_slots)
    VALUES ($1,$2,$3,$4,$4) ON CONFLICT (character_id, slot_type, slot_level) DO UPDATE
    SET max_slots = EXCLUDED.max_slots, current_slots = LEAST(character_spell_slots.current_slots, EXCLUDED.max_slots)`,
    [characterId, type, level, maximum]);
}

async function getClasses(client: pg.PoolClient, characterId: string): Promise<CharacterClass[]> {
  const result = await client.query<any>('SELECT class_name, level, subclass_name, spellcasting_ability FROM character_classes WHERE character_id = $1', [characterId]);
  return result.rows.map((row: any) => ({ className: row.class_name, level: row.level, subclassName: row.subclass_name, spellcastingAbility: row.spellcasting_ability }));
}

async function getAbilities(client: pg.PoolClient, characterId: string): Promise<CharacterAbility[]> {
  const result = await client.query<any>('SELECT ability_key, score FROM character_abilities WHERE character_id = $1', [characterId]);
  return result.rows.map((row: any) => ({ key: row.ability_key, score: row.score }));
}

export function isValidRechargePeriod(value: string): value is RechargePeriod {
  return rechargePeriods.has(value as RechargePeriod);
}
