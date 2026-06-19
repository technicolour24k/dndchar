import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { abilityModifier, abilityMap, proficiencyBonus, resolveResourceMaximum, rollDiceExpression, standardSpellSlotMaximums, pactMagicSlots, totalLevel } from '$lib/rules/dnd5e';
import type { AbilityKey, CharacterAbility, CharacterClass } from '$lib/types/character';
import type { CharacterContentInstance, ContentDefinition, ContentType, PublicationStatus, RechargePeriod, SpellSlot } from '$lib/types/content';

const contentTypes = new Set<ContentType>(['item', 'spell', 'feat', 'class_feature']);
const publicationStatuses = new Set<PublicationStatus>(['private', 'pending', 'published']);
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
      WHERE (c.publication_status = 'published' OR c.owner_user_id = $1)
        AND ($2::text IS NULL OR c.content_type = $2)
        AND ($3 = '' OR c.name ILIKE '%' || $3 || '%')
      ORDER BY c.source_kind = 'srd' DESC, c.name ASC
      LIMIT 300
    `,
    [userId, type || null, search.trim()]
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
    publicationStatus: row.publication_status,
    metadata: row.metadata_json || {},
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
       (content_key, content_type, name, description, source_kind, owner_user_id, publication_status, metadata_json)
       VALUES ($1, $2, $3, $4, 'homebrew', $5, 'private', $6) RETURNING id`,
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

export async function requestPublication(userId: string, contentId: string): Promise<void> {
  await query(`UPDATE content_definitions SET publication_status = 'pending', updated_at = now()
    WHERE id = $1 AND owner_user_id = $2 AND source_kind = 'homebrew'`, [contentId, userId]);
}

export async function publishContent(contentId: string, status: PublicationStatus): Promise<void> {
  if (!publicationStatuses.has(status)) throw new Error('Invalid publication status.');
  await query('UPDATE content_definitions SET publication_status = $2, updated_at = now() WHERE id = $1', [contentId, status]);
}

export async function listAdminCatalogue(): Promise<Array<{ id: string; name: string; type: ContentType; sourceKind: string; status: PublicationStatus; ownerName: string }>> {
  const result = await query<any>(`SELECT c.id, c.name, c.content_type, c.source_kind, c.publication_status,
    COALESCE(u.display_name, 'Global') AS owner_name FROM content_definitions c
    LEFT JOIN users u ON u.id = c.owner_user_id ORDER BY c.publication_status, c.content_type, c.name`);
  return result.rows.map((row: any) => ({ id: row.id, name: row.name, type: row.content_type,
    sourceKind: row.source_kind, status: row.publication_status, ownerName: row.owner_name }));
}

export async function attachEffectToContent(form: FormData): Promise<void> {
  const contentId = String(form.get('contentId') || '');
  const effectId = String(form.get('effectId') || '');
  const activationType = String(form.get('activationType') || 'manual');
  await query(`INSERT INTO content_effect_links (content_id, effect_id, activation_type)
    VALUES ($1,$2,$3) ON CONFLICT (content_id, effect_id, activation_type) DO NOTHING`,
    [contentId, effectId, activationType]);
}

export async function attachEffectToOwnedContent(userId: string, form: FormData): Promise<void> {
  const contentId = String(form.get('contentId') || '');
  const owned = await query('SELECT id FROM content_definitions WHERE id=$1 AND owner_user_id=$2', [contentId, userId]);
  if (!owned.rowCount) throw new Error('Private homebrew content not found.');
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
    WHERE $1::uuid IS NULL OR is_homebrew=false OR owner_user_id=$1 ORDER BY name`, [userId || null]);
  return result.rows;
}

export async function addContentToCharacter(userId: string, characterId: string, contentId: string): Promise<void> {
  await withTransaction(async (client) => {
    await assertCharacterOwner(client, userId, characterId);
    const visible = await client.query(`SELECT id FROM content_definitions WHERE id = $1
      AND (publication_status = 'published' OR owner_user_id = $2)`, [contentId, userId]);
    if (!visible.rowCount) throw new Error('Catalogue entry not found.');
    const definition = await client.query<any>(`SELECT c.content_type, c.name, i.* FROM content_definitions c
      LEFT JOIN item_definitions i ON i.content_id = c.id WHERE c.id = $1`, [contentId]);
    if (definition.rows[0]?.content_type === 'item') {
      const item = definition.rows[0];
      await client.query(`INSERT INTO character_inventory_items
        (character_id, name, category, quantity, equipped, location, is_equipment, ac_bonus, to_hit_bonus,
         damage_bonus, attack_ability, damage_rolls, source_content_id, attuned, notes, sort_order)
        VALUES ($1,$2,$3,1,false,'backpack',($3 IN ('weapon','armor','shield','focus')),$4,$5,$6,$7,$8,$9,false,'',
          COALESCE((SELECT max(sort_order)+1 FROM character_inventory_items WHERE character_id=$1),0))`,
        [characterId, item.name, item.category || 'gear', item.ac_bonus || 0, item.to_hit_bonus || 0,
          item.damage_bonus || 0, item.attack_ability || 'str', item.damage_rolls || '', contentId]);
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
    if (delta < 0) {
      await client.query(`INSERT INTO active_character_effects (character_id,effect_id,source_content_instance_id)
        SELECT $1,l.effect_id,$2 FROM content_effect_links l WHERE l.content_id=$3 AND l.activation_type='on_use'
        ON CONFLICT (character_id,effect_id) DO NOTHING`,
        [characterId, result.rows[0].character_content_id, result.rows[0].content_id]);
    }
  });
}

export async function listCharacterContent(characterId: string): Promise<CharacterContentInstance[]> {
  const result = await query<any>(`SELECT i.*, c.content_type, c.name, c.description, s.spell_level,
    EXISTS(SELECT 1 FROM content_resource_actions action WHERE action.content_id=c.id AND action.activation_type IN('manual','on_use')) AS has_resource_actions
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
  return [...instances, ...grants.rows.map((row: any): CharacterContentInstance => ({
    id: `grant:${row.id}`, contentId: row.content_id, type: row.content_type, name: row.name,
    description: row.description, isKnown: true, isPrepared: true, isActive: true, notes: '',
    spellLevel: null, grantedBy: row.source_name, resources: []
  }))];
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

export type ResourceActionResult={label:string;target:string;expression:string;rolled:number;before:number;after:number};

export async function useInventoryCatalogueItem(userId: string, characterId: string, inventoryId: string): Promise<ResourceActionResult[]> {
  return withTransaction(async (client) => {
    await assertCharacterOwner(client, userId, characterId);
    const item = await client.query<any>(`UPDATE character_inventory_items SET quantity=GREATEST(0,quantity-1)
      WHERE id=$1 AND character_id=$2 AND quantity>0 RETURNING source_content_id`, [inventoryId, characterId]);
    if (!item.rowCount) throw new Error('Inventory item is unavailable.');
    if (!item.rows[0].source_content_id) return [];
    const results=await executeResourceActions(client,characterId,item.rows[0].source_content_id,['on_use']);
    await client.query(`INSERT INTO active_character_effects (character_id,effect_id,source_content_instance_id)
      SELECT $1,l.effect_id,NULL FROM content_effect_links l WHERE l.content_id=$2 AND l.activation_type='on_use'
      ON CONFLICT (character_id,effect_id) DO NOTHING`, [characterId, item.rows[0].source_content_id]);
    return results;
  });
}

export async function triggerCharacterContentActions(userId:string,characterId:string,instanceId:string):Promise<ResourceActionResult[]>{
  return withTransaction(async(client)=>{
    await assertCharacterOwner(client,userId,characterId);
    const instance=await client.query<{content_id:string}>(`SELECT content_id FROM character_content_instances
      WHERE id=$1 AND character_id=$2`,[instanceId,characterId]);
    if(!instance.rowCount)throw new Error('Character content not found.');
    return executeResourceActions(client,characterId,instance.rows[0].content_id,['manual','on_use']);
  });
}

async function executeResourceActions(client:pg.PoolClient,characterId:string,contentId:string,activations:string[]):Promise<ResourceActionResult[]>{
  const actions=await client.query<any>(`SELECT action_operation,target_type,target_key,value_expression,label
    FROM content_resource_actions WHERE content_id=$1 AND activation_type=ANY($2::text[]) ORDER BY sort_order,created_at`,
    [contentId,activations]);
  const results:ResourceActionResult[]=[];
  for(const action of actions.rows){
    const rolled=rollDiceExpression(action.value_expression);
    const result=await applyResourceAction(client,characterId,action,rolled);
    if(result)results.push({...result,label:action.label||resourceActionDefaultLabel(action),expression:action.value_expression,rolled});
  }
  return results;
}

function adjustedValue(before:number,amount:number,operation:string,max:number|null):number{
  const raw=operation==='set'?amount:operation==='subtract'?before-amount:before+amount;
  return Math.max(0,max===null?raw:Math.min(max,raw));
}

async function applyResourceAction(client:pg.PoolClient,characterId:string,action:any,amount:number):Promise<Omit<ResourceActionResult,'label'|'expression'|'rolled'>|null>{
  if(action.target_type==='hp'||action.target_type==='temp_hp'){
    const key=action.target_type==='hp'?'hp':'temp_hp';
    const current=await client.query<{current_value:number;max_value:number}>('SELECT current_value,max_value FROM character_resources WHERE character_id=$1 AND resource_key=$2 FOR UPDATE',[characterId,key]);
    if(!current.rowCount)return null;
    const before=current.rows[0].current_value;
    const max=key==='hp'?current.rows[0].max_value:null;
    const after=adjustedValue(before,amount,action.action_operation,max);
    await client.query(`UPDATE character_resources SET current_value=$3,
      max_value=CASE WHEN resource_key='temp_hp' THEN GREATEST(max_value,$3) ELSE max_value END
      WHERE character_id=$1 AND resource_key=$2`,[characterId,key,after]);
    return{target:key==='hp'?'Hit Points':'Temporary HP',before,after};
  }
  if(action.target_type==='spell_slot'){
    const order=action.target_key==='lowest_expended'?'ASC':'DESC';
    const conditions=action.target_key==='pact'?`slot_type='pact'`:
      /^\d$/.test(action.target_key)?`slot_type='standard' AND slot_level=${Number(action.target_key)}`:
      `slot_type='standard' AND current_slots<max_slots`;
    const slot=await client.query<any>(`SELECT slot_type,slot_level,current_slots,max_slots FROM character_spell_slots
      WHERE character_id=$1 AND ${conditions} ORDER BY slot_level ${order} LIMIT 1 FOR UPDATE`,[characterId]);
    if(!slot.rowCount)return null;
    const before=slot.rows[0].current_slots;
    const after=adjustedValue(before,amount,action.action_operation,slot.rows[0].max_slots);
    await client.query(`UPDATE character_spell_slots SET current_slots=$4 WHERE character_id=$1 AND slot_type=$2 AND slot_level=$3`,
      [characterId,slot.rows[0].slot_type,slot.rows[0].slot_level,after]);
    return{target:`${slot.rows[0].slot_type==='pact'?'Pact':'Level '+slot.rows[0].slot_level} Spell Slots`,before,after};
  }
  if(action.target_type==='coin'){
    const metadataKey:{[key:string]:string}={cp:'currencyCp',sp:'currencySp',ep:'currencyEp',gp:'currencyGp',pp:'currencyPp'};
    const key=metadataKey[action.target_key];if(!key)return null;
    const current=await client.query<any>('SELECT metadata_json FROM characters WHERE id=$1 FOR UPDATE',[characterId]);
    const before=Number(current.rows[0]?.metadata_json?.[key])||0;
    const after=adjustedValue(before,amount,action.action_operation,null);
    await client.query(`UPDATE characters SET metadata_json=jsonb_set(metadata_json,$2::text[],to_jsonb($3::text),true),updated_at=now() WHERE id=$1`,
      [characterId,[key],after]);
    return{target:action.target_key.toUpperCase(),before,after};
  }
  return null;
}

function resourceActionDefaultLabel(action:any):string{
  const verb=action.action_operation==='add'?'Recover':action.action_operation==='subtract'?'Spend / Damage':'Set';
  return `${verb} ${action.target_type.replace('_',' ')}`;
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
    ) SELECT COALESCE(sum(
      CASE WHEN COALESCE(l.value_override_expression, m.default_value_expression, '') ~ '^-?[0-9]+$'
        THEN COALESCE(l.value_override_expression, m.default_value_expression)::integer ELSE 0 END), 0)::text AS bonus
    FROM effect_ids a JOIN effect_modifier_links l ON l.effect_id = a.effect_id
    JOIN modifier_definitions m ON m.id = l.modifier_id
    WHERE m.target = 'spell_slots.highest.max' AND m.modifier_type = 'bonus'`, [characterId]);
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
