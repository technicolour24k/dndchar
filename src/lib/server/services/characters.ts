import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { abilityKeys, clampResource } from '$lib/rules/dnd5e';
import { getCombatClock, listCharacterContent, listSpellSlots, syncCharacterSpellSlots } from '$lib/server/services/catalogue';
import { resolveCharacterModifierSources } from '$lib/server/services/rule-engine';
import { applyCharacterEffect } from '$lib/server/services/effects';
import type {
  AbilityKey,
  CharacterAbility,
  CharacterAttack,
  CharacterClass,
  CharacterDetail,
  CharacterListItem,
  CharacterNote,
  CharacterProficiencies,
  CharacterResource,
  CharacterVersion,
  EffectDefinition,
  EffectModifier,
  ItemCategory,
  InventoryItem
} from '$lib/types/character';

type CharacterRow = {
  id: string;
  owner_user_id: string;
  name: string;
  ancestry: string;
  background: string;
  system_key: string;
  metadata_json: Record<string, unknown>;
  updated_at: string;
};

type CharacterSnapshot = {
  character?: {
    name?: string;
    ancestry?: string;
    background?: string;
    system_key?: string;
    metadata_json?: Record<string, unknown>;
  };
  classes?: Array<{ class_name?: string; level?: number }>;
  abilities?: Array<{ ability_key?: AbilityKey; score?: number }>;
  resources?: Array<{ resource_key?: string; label?: string; current_value?: number; max_value?: number }>;
  inventory?: Array<{
    id?: string;
    name?: string;
    category?: string;
    quantity?: number;
    equipped?: boolean;
    ac_bonus?: number;
    str_bonus?: number;
    dex_bonus?: number;
    con_bonus?: number;
    int_bonus?: number;
    wis_bonus?: number;
    cha_bonus?: number;
    notes?: string;
    location?: string;
    is_equipment?: boolean;
    to_hit_bonus?: number;
    damage_bonus?: number;
    attack_ability?: AbilityKey;
    proficient?: boolean;
    damage_rolls?: string;
    effects?: string;
    source_content_id?: string | null;
    attuned?: boolean;
  }>;
  attacks?: Array<{ name?: string; attack_ability?: AbilityKey; proficient?: boolean; damage_dice?: string; notes?: string }>;
  notes?: Array<{ note_key?: string; title?: string; content?: string }>;
  proficiencies?: Array<{ proficiency_type?: string; proficiency_key?: string }>;
  active_effects?: Array<{ effect_key?: string; application_key?: string; source_key?: string|null; remaining_rounds?: number | null; metadata_json?: Record<string, unknown>; source_content_instance_id?: string | null; expiry_boundary?: string }>;
  exhaustion?: { exhaustion_level?: number };
  content_instances?: any[];
  content_resources?: any[];
  inventory_resources?: any[];
  spell_slots?: any[];
  combat_clock?: any;
};

const defaultClasses: CharacterClass[] = [{ className: 'Fighter', level: 1 }];
const defaultResources: CharacterResource[] = [
  { key: 'hp', label: 'HP', currentValue: 10, maxValue: 10 },
  { key: 'temp_hp', label: 'Temp HP', currentValue: 0, maxValue: 0 },
  { key: 'inspiration', label: 'Inspiration', currentValue: 0, maxValue: 1 }
];
const defaultNotes: CharacterNote[] = [
  { key: 'attacks', title: 'Attacks & Spellcasting', content: '' },
  { key: 'spellcasting', title: 'Spellcasting Notes', content: '' },
  { key: 'battle_notes', title: 'Battle Notes', content: '' },
  { key: 'saving_throws', title: 'Saving Throws', content: '' },
  { key: 'skills', title: 'Skills', content: '' },
  { key: 'conditions', title: 'Conditions & Effects', content: '' },
  { key: 'spell_slots', title: 'Spell Slots', content: '' },
  { key: 'prepared_spells', title: 'Prepared Spells', content: '' },
  { key: 'class_features', title: 'Class Features', content: '' },
  { key: 'feats', title: 'Feats', content: '' },
  { key: 'traits', title: 'Traits', content: '' },
  { key: 'usable_traits', title: 'Usable Traits', content: '' },
  { key: 'proficiencies_languages', title: 'Proficiencies & Languages', content: '' },
  { key: 'limited_uses', title: 'Limited Uses', content: '' },
  { key: 'treasure', title: 'Treasure & Valuables', content: '' },
  { key: 'general_inventory', title: 'General Inventory', content: '' },
  { key: 'personality', title: 'Personality Traits', content: '' },
  { key: 'ideals', title: 'Ideals', content: '' },
  { key: 'bonds', title: 'Bonds', content: '' },
  { key: 'flaws', title: 'Flaws', content: '' },
  { key: 'backstory', title: 'Backstory', content: '' },
  { key: 'allies_organizations', title: 'Allies & Organizations', content: '' },
  { key: 'appearance', title: 'Appearance', content: '' },
  { key: 'additional_notes', title: 'Additional Notes', content: '' }
];

const metadataFields = [
  'race',
  'alignment',
  'playerName',
  'experiencePoints',
  'armorClass',
  'initiative',
  'speed',
  'hitDice',
  'deathSaveSuccesses',
  'deathSaveFailures',
  'passivePerception',
  'spellcastingAbility',
  'spellSaveDc',
  'spellAttackBonus',
  'currencyCp',
  'currencySp',
  'currencyEp',
  'currencyGp',
  'currencyPp',
  'age',
  'height',
  'weight',
  'eyes',
  'skin',
  'hair'
];

function mapCharacterRow(row: CharacterRow, detail: Omit<CharacterDetail, keyof CharacterRow | 'ownerUserId' | 'systemKey' | 'metadata' | 'updatedAt'>): CharacterDetail {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    name: row.name,
    ancestry: row.ancestry,
    background: row.background,
    systemKey: row.system_key,
    metadata: row.metadata_json || {},
    updatedAt: row.updated_at,
    ...detail
  };
}

export async function listCharacters(userId: string): Promise<CharacterListItem[]> {
  const characters = await query<CharacterRow>(
    `
      SELECT id, owner_user_id, name, ancestry, background, system_key, metadata_json, updated_at
      FROM characters
      WHERE owner_user_id = $1
      ORDER BY updated_at DESC
    `,
    [userId]
  );

  const list: CharacterListItem[] = [];
  for (const row of characters.rows) {
    const classes = await getClasses(row.id);
    const resources = await getResources(row.id);
    const hp = resources.find((resource) => resource.key === 'hp');
    list.push({
      id: row.id,
      name: row.name,
      ancestry: row.ancestry,
      background: row.background,
      systemKey: row.system_key,
      classes,
      hpCurrent: hp?.currentValue ?? 0,
      hpMax: hp?.maxValue ?? 0,
      updatedAt: row.updated_at
    });
  }
  return list;
}

export async function createCharacter(userId: string, name: string): Promise<string> {
  const id = await withTransaction(async (client) => {
    const created = await client.query<{ id: string }>(
      `
        INSERT INTO characters (owner_user_id, name, metadata_json)
        VALUES ($1, $2, $3)
        RETURNING id
      `,
      [userId, name.trim() || 'New Character', { use5eHelpers: true }]
    );
    const characterId = created.rows[0].id;

    await replaceClasses(client, characterId, defaultClasses);
    await replaceAbilities(
      client,
      characterId,
      abilityKeys.map((key) => ({ key, score: 10 }))
    );
    await replaceResources(client, characterId, defaultResources);
    await replaceNotes(client, characterId, defaultNotes);
    await createVersionWithClient(client, characterId, userId, 'Created character');
    return characterId;
  });

  return id;
}

export async function getCharacter(userId: string, characterId: string): Promise<CharacterDetail | null> {
  const result = await query<CharacterRow>(
    `
      SELECT id, owner_user_id, name, ancestry, background, system_key, metadata_json, updated_at
      FROM characters
      WHERE id = $1 AND owner_user_id = $2
    `,
    [characterId, userId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const resolvedModifiers = await resolveCharacterModifierSources(characterId);

  return mapCharacterRow(row, {
    classes: await getClasses(characterId),
    abilities: await getAbilities(characterId),
    resources: await getResources(characterId),
    inventory: await getInventory(characterId),
    attacks: await getAttacks(characterId),
    notes: await getNotes(characterId),
    proficiencies: await getProficiencies(characterId),
    activeEffects: await getActiveEffects(characterId),
    modifierSources: resolvedModifiers.sources,
    modifierAudit: resolvedModifiers.audit,
    availableEffects: await listEffectDefinitions(),
    exhaustionLevel: await getExhaustionLevel(characterId),
    content: await listCharacterContent(characterId),
    spellSlots: await listSpellSlots(characterId),
    combatClock: await getCombatClock(characterId)
  });
}

export async function listItemCategories(): Promise<ItemCategory[]> {
  try {
    const result = await query<{ key: string; label: string }>(
      'SELECT key, label FROM item_categories ORDER BY sort_order ASC, label ASC'
    );
    return result.rows;
  } catch {
    return [
      { key: 'weapon', label: 'Weapon' },
      { key: 'armor', label: 'Armor' },
      { key: 'shield', label: 'Shield' },
      { key: 'focus', label: 'Spell Focus' },
      { key: 'consumable', label: 'Consumable' },
      { key: 'tool', label: 'Tool' },
      { key: 'gear', label: 'Adventuring Gear' },
      { key: 'treasure', label: 'Treasure' },
      { key: 'junk', label: 'Junk' },
      { key: 'misc', label: 'Misc' }
    ];
  }
}

export async function updateCharacter(userId: string, characterId: string, form: FormData, summary: string): Promise<void> {
  await withTransaction(async (client) => {
    const owned = await client.query('SELECT id FROM characters WHERE id = $1 AND owner_user_id = $2', [characterId, userId]);
    if (!owned.rowCount) throw new Error('Character not found.');

    await client.query(
      `
        UPDATE characters
        SET name = $1,
            ancestry = $2,
            background = $3,
            metadata_json = metadata_json || $4::jsonb,
            updated_at = now()
        WHERE id = $5
      `,
      [
        String(form.get('name') || '').trim() || 'Unnamed Character',
        String(form.get('ancestry') || '').trim(),
        String(form.get('background') || '').trim(),
        JSON.stringify(parseMetadata(form)),
        characterId
      ]
    );

    await replaceClasses(client, characterId, parseClasses(form));
    await replaceAbilities(client, characterId, parseAbilities(form));
    await replaceResources(client, characterId, parseResources(form));
    await replaceInventory(client, characterId, parseInventory(form));
    await replaceAttacks(client, characterId, parseAttacks(form));
    await replaceNotes(client, characterId, parseNotes(form));
    await replaceProficiencies(client, characterId, parseProficiencies(form));
    await replaceActiveEffects(client, characterId, parseActiveEffectKeys(form));
    await setExhaustionLevel(client, characterId, Number(form.get('exhaustionLevel')) || 0);
    await createVersionWithClient(client, characterId, userId, summary);
  });
  await syncCharacterSpellSlots(userId, characterId);
}

export async function listVersions(userId: string, characterId: string): Promise<CharacterVersion[]> {
  const result = await query<{
    id: string;
    character_id: string;
    created_at: string;
    change_summary: string;
  }>(
    `
      SELECT character_versions.id, character_versions.character_id, character_versions.created_at, character_versions.change_summary
      FROM character_versions
      JOIN characters ON characters.id = character_versions.character_id
      WHERE character_versions.character_id = $1 AND characters.owner_user_id = $2
      ORDER BY character_versions.created_at DESC
      LIMIT 20
    `,
    [characterId, userId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    characterId: row.character_id,
    createdAt: row.created_at,
    changeSummary: row.change_summary
  }));
}

export async function restoreCharacterVersion(userId: string, characterId: string, versionId: string): Promise<void> {
  return await withTransaction(async (client) => {
    const version = await client.query<{
      character_id: string;
      created_at: string;
      snapshot_json: CharacterSnapshot;
    }>(
      `
        SELECT character_versions.character_id, character_versions.created_at, character_versions.snapshot_json
        FROM character_versions
        JOIN characters ON characters.id = character_versions.character_id
        WHERE character_versions.id = $1
          AND character_versions.character_id = $2
          AND characters.owner_user_id = $3
      `,
      [versionId, characterId, userId]
    );
    const row = version.rows[0];
    if (!row) throw new Error('Version not found.');

    await createVersionWithClient(client, characterId, userId, 'Before restore');
    await applySnapshot(client, characterId, row.snapshot_json);
  });
}

async function createVersionWithClient(client: pg.PoolClient, characterId: string, userId: string, summary: string): Promise<void> {
  const snapshot = await buildSnapshot(client, characterId);
  await client.query(
    `
      INSERT INTO character_versions (character_id, created_by_user_id, change_summary, snapshot_json)
      VALUES ($1, $2, $3, $4)
    `,
    [characterId, userId, summary, snapshot]
  );
}

async function buildSnapshot(client: pg.PoolClient, characterId: string): Promise<Record<string, unknown>> {
  const character = await client.query('SELECT * FROM characters WHERE id = $1', [characterId]);
  const classes = await client.query('SELECT class_name, level, sort_order FROM character_classes WHERE character_id = $1 ORDER BY sort_order', [characterId]);
  const abilities = await client.query('SELECT ability_key, score FROM character_abilities WHERE character_id = $1 ORDER BY ability_key', [characterId]);
  const resources = await client.query('SELECT resource_key, label, current_value, max_value, sort_order FROM character_resources WHERE character_id = $1 ORDER BY sort_order', [characterId]);
  const inventory = await client.query('SELECT * FROM character_inventory_items WHERE character_id = $1 ORDER BY sort_order', [characterId]);
  const attacks = await client.query('SELECT * FROM character_attacks WHERE character_id = $1 ORDER BY sort_order', [characterId]);
  const notes = await client.query('SELECT note_key, title, content, sort_order FROM character_notes WHERE character_id = $1 ORDER BY sort_order', [characterId]);
  const proficiencies = await client.query('SELECT proficiency_type, proficiency_key FROM character_proficiencies WHERE character_id = $1 ORDER BY proficiency_type, proficiency_key', [characterId]);
  const activeEffects = await client.query(
    `
      SELECT effect_definitions.effect_key, active_character_effects.remaining_rounds, active_character_effects.metadata_json,
        active_character_effects.source_content_instance_id, active_character_effects.expiry_boundary,
        active_character_effects.application_key,active_character_effects.source_key
      FROM active_character_effects
      JOIN effect_definitions ON effect_definitions.id = active_character_effects.effect_id
      WHERE active_character_effects.character_id = $1
      ORDER BY effect_definitions.sort_order, effect_definitions.name
    `,
    [characterId]
  );
  const exhaustion = await client.query('SELECT exhaustion_level FROM character_exhaustion WHERE character_id = $1', [characterId]);
  const contentInstances = await client.query('SELECT * FROM character_content_instances WHERE character_id = $1 ORDER BY created_at', [characterId]);
  const contentResources = await client.query(`SELECT r.* FROM character_content_resources r
    JOIN character_content_instances i ON i.id = r.character_content_id WHERE i.character_id = $1`, [characterId]);
  const spellSlots = await client.query('SELECT * FROM character_spell_slots WHERE character_id = $1 ORDER BY slot_type, slot_level', [characterId]);
  const inventoryResources=await client.query(`SELECT resource.* FROM character_inventory_resources resource
    JOIN character_inventory_items inventory ON inventory.id=resource.inventory_item_id WHERE inventory.character_id=$1`,[characterId]);
  const combatClock = await client.query('SELECT * FROM character_combat_clocks WHERE character_id = $1', [characterId]);

  return {
    character: character.rows[0],
    classes: classes.rows,
    abilities: abilities.rows,
    resources: resources.rows,
    inventory: inventory.rows,
    attacks: attacks.rows,
    notes: notes.rows,
    proficiencies: proficiencies.rows,
    active_effects: activeEffects.rows,
    exhaustion: exhaustion.rows[0] ?? { exhaustion_level: 0 },
    content_instances: contentInstances.rows,
    content_resources: contentResources.rows,
    inventory_resources:inventoryResources.rows,
    spell_slots: spellSlots.rows,
    combat_clock: combatClock.rows[0] ?? null
  };
}

async function applySnapshot(client: pg.PoolClient, characterId: string, snapshot: CharacterSnapshot): Promise<void> {
  const character = snapshot.character ?? {};
  const restoredClasses = snapshot.classes?.length
    ? snapshot.classes
    : defaultClasses.map((row) => ({ class_name: row.className, level: row.level }));
  const restoredAbilities = snapshot.abilities?.length
    ? snapshot.abilities
    : abilityKeys.map((key) => ({ ability_key: key, score: 10 }));
  const restoredResources = snapshot.resources?.length
    ? snapshot.resources
    : defaultResources.map((row) => ({
        resource_key: row.key,
        label: row.label,
        current_value: row.currentValue,
        max_value: row.maxValue
      }));
  const restoredNotes = snapshot.notes?.length
    ? snapshot.notes
    : defaultNotes.map((row) => ({ note_key: row.key, title: row.title, content: row.content }));

  await client.query(
    `
      UPDATE characters
      SET name = $1,
          ancestry = $2,
          background = $3,
          system_key = $4,
          metadata_json = $5::jsonb,
          updated_at = now()
      WHERE id = $6
    `,
    [
      character.name || 'Restored Character',
      character.ancestry || '',
      character.background || '',
      character.system_key || 'dnd5e2014',
      JSON.stringify(character.metadata_json || {}),
      characterId
    ]
  );

  await replaceClasses(
    client,
    characterId,
    restoredClasses.map((row) => ({
      className: row.class_name || 'Fighter',
      level: Math.max(1, Number(row.level) || 1)
    }))
  );
  await replaceAbilities(
    client,
    characterId,
    restoredAbilities.map((row) => ({
      key: row.ability_key as AbilityKey,
      score: Math.max(1, Number(row.score) || 10)
    })).filter((row) => abilityKeys.includes(row.key))
  );
  await replaceResources(
    client,
    characterId,
    restoredResources.map((row) => ({
      key: row.resource_key || 'resource',
      label: row.label || row.resource_key || 'Resource',
      currentValue: Number(row.current_value) || 0,
      maxValue: Number(row.max_value) || 0
    }))
  );
  await replaceInventory(
    client,
    characterId,
    (snapshot.inventory ?? []).map((row) => ({
      id: row.id,
      name: row.name || '',
      category: row.category || 'gear',
      location: normalizeInventoryLocation(row.location, Boolean(row.equipped)),
      quantity: Number(row.quantity) || 1,
      equipped: Boolean(row.equipped),
      isEquipment: Boolean(row.is_equipment),
      acBonus: Number(row.ac_bonus) || 0,
      toHitBonus: Number(row.to_hit_bonus) || 0,
      damageBonus: Number(row.damage_bonus) || 0,
      attackAbility: abilityKeys.includes(row.attack_ability as AbilityKey) ? (row.attack_ability as AbilityKey) : 'str',
      proficient: row.proficient ?? true,
      sourceContentId: row.source_content_id || null,
      attuned: row.attuned || false,
      damageRolls: row.damage_rolls || '',
      effects: row.effects || '',
      abilityBonuses: {
        str: Number(row.str_bonus) || 0,
        dex: Number(row.dex_bonus) || 0,
        con: Number(row.con_bonus) || 0,
        int: Number(row.int_bonus) || 0,
        wis: Number(row.wis_bonus) || 0,
        cha: Number(row.cha_bonus) || 0
      },
      notes: row.notes || ''
    }))
  );
  await replaceAttacks(
    client,
    characterId,
    (snapshot.attacks ?? []).map((row) => ({
      name: row.name || '',
      attackAbility: abilityKeys.includes(row.attack_ability as AbilityKey) ? (row.attack_ability as AbilityKey) : 'str',
      proficient: row.proficient ?? true,
      damageDice: row.damage_dice || '',
      notes: row.notes || ''
    }))
  );
  await replaceNotes(
    client,
    characterId,
    restoredNotes.map((row) => ({
      key: row.note_key || 'note',
      title: row.title || row.note_key || 'Note',
      content: row.content || ''
    }))
  );
  for(const row of snapshot.inventory_resources??[]){await client.query(`INSERT INTO character_inventory_resources
    (id,inventory_item_id,resource_definition_id,current_value,max_value)
    SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT 1 FROM character_inventory_items WHERE id=$2)
      AND EXISTS(SELECT 1 FROM content_resource_definitions WHERE id=$3)`,[row.id,row.inventory_item_id,row.resource_definition_id,row.current_value,row.max_value]);}
  await replaceProficiencies(
    client,
    characterId,
    (snapshot.proficiencies ?? []).map((row) => ({
      type: row.proficiency_type || '',
      key: row.proficiency_key || ''
    }))
  );
  await restoreStructuredContent(client, characterId, snapshot);
  await client.query('DELETE FROM active_character_effects WHERE character_id=$1',[characterId]);
  for (const row of snapshot.active_effects ?? []) {
    await client.query(`INSERT INTO active_character_effects(character_id,effect_id,remaining_rounds,metadata_json,
      source_content_instance_id,expiry_boundary,application_key,source_key)
      SELECT $1,effect.id,$2,$3,$4,$5,COALESCE($6::uuid,gen_random_uuid()),$7 FROM effect_definitions effect WHERE effect.effect_key=$8`,
      [characterId,row.remaining_rounds??null,JSON.stringify(row.metadata_json||{}),row.source_content_instance_id||null,
        row.expiry_boundary||'round_end',row.application_key||null,row.source_key||null,row.effect_key]);
  }
  await setExhaustionLevel(client, characterId, Number(snapshot.exhaustion?.exhaustion_level) || 0);
}

async function restoreStructuredContent(client: pg.PoolClient, characterId: string, snapshot: CharacterSnapshot): Promise<void> {
  await client.query('DELETE FROM character_content_instances WHERE character_id = $1', [characterId]);
  for (const row of snapshot.content_instances ?? []) {
    const contentExists = await client.query('SELECT id FROM content_definitions WHERE id = $1', [row.content_id]);
    if (!contentExists.rowCount) continue;
    await client.query(`INSERT INTO character_content_instances
      (id, character_id, content_id, source_class_id, is_known, is_prepared, is_active, custom_name, notes, metadata_json, created_at)
      VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,COALESCE($10,now()))`,
      [row.id, characterId, row.content_id, row.is_known, row.is_prepared, row.is_active, row.custom_name,
        row.notes || '', JSON.stringify(row.metadata_json || {}), row.created_at]);
  }
  for (const row of snapshot.content_resources ?? []) {
    await client.query(`INSERT INTO character_content_resources
      (id, character_content_id, resource_definition_id, current_value, max_value)
      SELECT $1,$2,$3,$4,$5 WHERE EXISTS (SELECT 1 FROM character_content_instances WHERE id=$2)
        AND EXISTS (SELECT 1 FROM content_resource_definitions WHERE id=$3)`,
      [row.id, row.character_content_id, row.resource_definition_id, row.current_value, row.max_value]);
  }
  await client.query('DELETE FROM character_spell_slots WHERE character_id = $1', [characterId]);
  for (const row of snapshot.spell_slots ?? []) {
    await client.query(`INSERT INTO character_spell_slots
      (character_id, slot_type, slot_level, current_slots, max_slots) VALUES ($1,$2,$3,$4,$5)`,
      [characterId, row.slot_type, row.slot_level, row.current_slots, row.max_slots]);
  }
  if (snapshot.combat_clock) {
    await client.query(`INSERT INTO character_combat_clocks (character_id, round_number, turn_number, updated_at)
      VALUES ($1,$2,$3,now()) ON CONFLICT (character_id) DO UPDATE
      SET round_number=EXCLUDED.round_number, turn_number=EXCLUDED.turn_number, updated_at=now()`,
      [characterId, snapshot.combat_clock.round_number, snapshot.combat_clock.turn_number]);
  }
}

async function getClasses(characterId: string): Promise<CharacterClass[]> {
  const result = await query<{ class_name: string; level: number; subclass_name: string; spellcasting_ability: AbilityKey | null }>(
    'SELECT class_name, level, subclass_name, spellcasting_ability FROM character_classes WHERE character_id = $1 ORDER BY sort_order ASC',
    [characterId]
  );
  return result.rows.map((row) => ({ className: row.class_name, level: row.level, subclassName: row.subclass_name, spellcastingAbility: row.spellcasting_ability }));
}

async function getAbilities(characterId: string): Promise<CharacterAbility[]> {
  const result = await query<{ ability_key: AbilityKey; score: number }>(
    'SELECT ability_key, score FROM character_abilities WHERE character_id = $1 ORDER BY ability_key ASC',
    [characterId]
  );
  return result.rows.map((row) => ({ key: row.ability_key, score: row.score }));
}

async function getResources(characterId: string): Promise<CharacterResource[]> {
  const result = await query<{ resource_key: string; label: string; current_value: number; max_value: number }>(
    'SELECT resource_key, label, current_value, max_value FROM character_resources WHERE character_id = $1 ORDER BY sort_order ASC',
    [characterId]
  );
  return result.rows.map((row) => ({
    key: row.resource_key,
    label: row.label,
    currentValue: row.current_value,
    maxValue: row.max_value
  }));
}

async function getInventory(characterId: string): Promise<InventoryItem[]> {
  const result = await query<{
    id: string;
    name: string;
    category: string;
    quantity: number;
    equipped: boolean;
    ac_bonus: number;
    str_bonus: number;
    dex_bonus: number;
    con_bonus: number;
    int_bonus: number;
    wis_bonus: number;
    cha_bonus: number;
    notes: string;
    location: 'equipped' | 'backpack' | 'misc';
    is_equipment: boolean;
    to_hit_bonus: number;
    damage_bonus: number;
    attack_ability: AbilityKey;
    proficient: boolean;
    damage_rolls: string;
    effects: string;
    source_content_id: string | null;
    attuned: boolean;
  }>('SELECT * FROM character_inventory_items WHERE character_id = $1 ORDER BY sort_order ASC', [characterId]);
  const resources=await query<any>(`SELECT resource.id,resource.inventory_item_id,definition.resource_key,definition.label,
    definition.recharge_period,resource.current_value,resource.max_value FROM character_inventory_resources resource
    JOIN content_resource_definitions definition ON definition.id=resource.resource_definition_id
    JOIN character_inventory_items inventory ON inventory.id=resource.inventory_item_id WHERE inventory.character_id=$1`,[characterId]);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    location: row.location || (row.equipped ? 'equipped' : 'backpack'),
    quantity: row.quantity,
    equipped: row.equipped,
    isEquipment: row.is_equipment,
    acBonus: row.ac_bonus,
    toHitBonus: row.to_hit_bonus,
    damageBonus: row.damage_bonus,
    attackAbility: row.attack_ability || 'str',
    proficient: row.proficient ?? true,
    sourceContentId: row.source_content_id,
    attuned: row.attuned,
    damageRolls: row.damage_rolls,
    effects: row.effects,
    abilityBonuses: {
      str: row.str_bonus,
      dex: row.dex_bonus,
      con: row.con_bonus,
      int: row.int_bonus,
      wis: row.wis_bonus,
      cha: row.cha_bonus
    },
    notes: row.notes,
    resources:resources.rows.filter((resource:any)=>resource.inventory_item_id===row.id).map((resource:any)=>({id:resource.id,key:resource.resource_key,
      label:resource.label,currentValue:resource.current_value,maxValue:resource.max_value,rechargePeriod:resource.recharge_period}))
  }));
}

async function getAttacks(characterId: string): Promise<CharacterAttack[]> {
  const result = await query<{
    id: string;
    name: string;
    attack_ability: AbilityKey;
    proficient: boolean;
    damage_dice: string;
    notes: string;
  }>('SELECT * FROM character_attacks WHERE character_id = $1 ORDER BY sort_order ASC', [characterId]);
  return result.rows.map((row) => ({
    id: row.id,
    name: row.name,
    attackAbility: row.attack_ability,
    proficient: row.proficient,
    damageDice: row.damage_dice,
    notes: row.notes
  }));
}

async function getNotes(characterId: string): Promise<CharacterNote[]> {
  const result = await query<{ note_key: string; title: string; content: string }>(
    'SELECT note_key, title, content FROM character_notes WHERE character_id = $1 ORDER BY sort_order ASC',
    [characterId]
  );
  return result.rows.map((row) => ({ key: row.note_key, title: row.title, content: row.content }));
}

async function getProficiencies(characterId: string): Promise<CharacterProficiencies> {
  try {
    const result = await query<{ proficiency_type: string; proficiency_key: string }>(
      'SELECT proficiency_type, proficiency_key FROM character_proficiencies WHERE character_id = $1 ORDER BY proficiency_type, proficiency_key',
      [characterId]
    );
    return {
      savingThrows: result.rows
        .filter((row) => row.proficiency_type === 'saving_throw' && abilityKeys.includes(row.proficiency_key as AbilityKey))
        .map((row) => row.proficiency_key as AbilityKey),
      skills: result.rows.filter((row) => row.proficiency_type === 'skill').map((row) => row.proficiency_key),
      weapons: result.rows.filter((row) => row.proficiency_type === 'weapon').map((row) => row.proficiency_key)
    };
  } catch {
    return { savingThrows: [], skills: [], weapons: [] };
  }
}

async function listEffectDefinitions(includeArchived=false): Promise<EffectDefinition[]> {
  try {
    const effects = await query<{
      id: string;
      effect_key: string;
      name: string;
      source_type: string;
      source_ref: string;
      source_name: string;
      description: string;
      duration_type: string;
      duration_rounds: number | null;
      requires_concentration: boolean;
      is_condition: boolean;
      is_selectable: boolean;
    }>(
      `
        SELECT
          effect_definitions.id,
          effect_definitions.effect_key,
          effect_definitions.name,
          effect_definitions.source_type,
          effect_definitions.source_ref,
          COALESCE(source_label.source_name, effect_definitions.name) AS source_name,
          effect_definitions.description,
          effect_definitions.duration_type,
          effect_definitions.duration_rounds,
          effect_definitions.requires_concentration,
          effect_definitions.is_condition,
          COALESCE(effect_definitions.is_selectable, true) AS is_selectable
        FROM effect_definitions
        LEFT JOIN LATERAL (
          SELECT effect_sources.source_name
          FROM effect_sources
          WHERE effect_sources.effect_id = effect_definitions.id
          ORDER BY effect_sources.created_at ASC
          LIMIT 1
        ) source_label ON true
        WHERE ($1::boolean OR effect_definitions.is_archived=false)
        ORDER BY effect_definitions.is_condition DESC, effect_definitions.sort_order ASC, effect_definitions.name ASC
      `
      ,[includeArchived]
    );

    const modifiers = await listEffectModifiers();
    const modifiersByEffect = new Map<string, EffectModifier[]>();
    for (const row of modifiers) {
      const list = modifiersByEffect.get(row.effect_id) ?? [];
      list.push({
        target: row.target,
        modifierType: row.modifier_type,
        label: '',
        valueExpression: row.value_expression || '',
        defaultValueExpression: row.default_value_expression || '',
        valueOverrideExpression: row.value_override_expression || '',
        conditionExpression: row.condition_expression || '',
        priority: row.priority
      });
      modifiersByEffect.set(row.effect_id, list);
    }

    return effects.rows.map((row) => ({
      id: row.id,
      key: row.effect_key,
      name: row.name,
      sourceType: row.source_type,
      sourceRef: row.source_ref || '',
      sourceName: row.source_name || row.name,
      description: row.description || '',
      durationType: row.duration_type || '',
      durationRounds: row.duration_rounds,
      requiresConcentration: row.requires_concentration,
      isCondition: row.is_condition,
      isSelectable: row.is_selectable,
      modifiers: modifiersByEffect.get(row.id) ?? []
    }));
  } catch {
    return [];
  }
}

async function listEffectModifiers(): Promise<Array<{
  effect_id: string;
  target: string;
  modifier_type: string;
  default_value_expression: string;
  value_override_expression: string;
  value_expression: string;
  condition_expression: string;
  priority: number;
}>> {
  const result = await query<{
    effect_id: string;
    target: string;
    modifier_type: string;
    default_value_expression: string;
    value_override_expression: string;
    value_expression: string;
    condition_expression: string;
    priority: number;
  }>(
    `
      SELECT
        effect_modifier_links.effect_id,
        modifier_definitions.target,
        modifier_definitions.modifier_type,
        modifier_definitions.default_value_expression,
        effect_modifier_links.value_override_expression,
        COALESCE(effect_modifier_links.value_override_expression, modifier_definitions.default_value_expression) AS value_expression,
        effect_modifier_links.condition_expression,
        effect_modifier_links.priority
      FROM effect_modifier_links
      JOIN modifier_definitions ON modifier_definitions.id = effect_modifier_links.modifier_id
      ORDER BY effect_modifier_links.priority ASC, modifier_definitions.target ASC
    `
  );
  return result.rows;
}

async function getActiveEffects(characterId: string): Promise<CharacterDetail['activeEffects']> {
  const definitions = await listEffectDefinitions(true);
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  try {
    const active = await query<{
      id: string;
      effect_id: string;
      remaining_rounds: number | null;
    }>(
      `
        SELECT id::text, effect_id, remaining_rounds FROM active_character_effects WHERE character_id = $1
        UNION ALL
        SELECT ('content:' || i.id::text || ':' || l.id::text), l.effect_id, NULL
        FROM character_content_instances i
        JOIN content_definitions c ON c.id = i.content_id
        JOIN content_effect_links l ON l.content_id = i.content_id
        WHERE i.character_id = $1 AND i.is_active = true AND c.content_type <> 'item'
          AND l.activation_type IN ('carried', 'equipped', 'attuned', 'manual')
        UNION ALL
        SELECT ('item:' || inventory.id::text || ':' || l.id::text), l.effect_id, NULL
        FROM character_inventory_items inventory
        JOIN content_effect_links l ON l.content_id = inventory.source_content_id
        WHERE inventory.character_id = $1 AND (
          l.activation_type = 'carried'
          OR (l.activation_type = 'equipped' AND inventory.equipped)
          OR (l.activation_type = 'attuned' AND inventory.attuned)
        )
        UNION ALL
        SELECT ('grant:' || inventory.id::text || ':' || granted_link.id::text), granted_link.effect_id, NULL
        FROM character_inventory_items inventory
        JOIN content_grants grant_link ON grant_link.source_content_id = inventory.source_content_id
        JOIN content_effect_links granted_link ON granted_link.content_id = grant_link.granted_content_id
        WHERE inventory.character_id = $1 AND (
          grant_link.activation_type = 'carried'
          OR (grant_link.activation_type = 'equipped' AND inventory.equipped)
          OR (grant_link.activation_type = 'attuned' AND inventory.attuned)
        )
      `,
      [characterId]
    );

    return active.rows
      .map((row) => {
        const definition = byId.get(row.effect_id);
        if (!definition) return null;
        return {
          id: row.id,
          effectId: row.effect_id,
          effectKey: definition.key,
          name: definition.name,
          sourceType: definition.sourceType,
          sourceName: definition.sourceName,
          description: definition.description,
          durationType: definition.durationType,
          requiresConcentration: definition.requiresConcentration,
          isCondition: definition.isCondition,
          isSelectable: definition.isSelectable,
          remainingRounds: row.remaining_rounds,
          modifiers: definition.modifiers
        };
      })
      .filter((effect): effect is CharacterDetail['activeEffects'][number] => Boolean(effect));
  } catch {
    return [];
  }
}

async function getExhaustionLevel(characterId: string): Promise<number> {
  try {
    const result = await query<{ exhaustion_level: number }>(
      'SELECT exhaustion_level FROM character_exhaustion WHERE character_id = $1',
      [characterId]
    );
    return result.rows[0]?.exhaustion_level ?? 0;
  } catch {
    return 0;
  }
}

async function replaceClasses(client: pg.PoolClient, characterId: string, classes: CharacterClass[]): Promise<void> {
  await client.query('DELETE FROM character_classes WHERE character_id = $1', [characterId]);
  for (const [index, row] of classes.entries()) {
    await client.query(
      'INSERT INTO character_classes (character_id, class_name, level, subclass_name, spellcasting_ability, sort_order) VALUES ($1, $2, $3, $4, $5, $6)',
      [characterId, row.className || 'Fighter', Math.max(1, Number(row.level) || 1), row.subclassName || '', row.spellcastingAbility || null, index]
    );
  }
}

async function replaceAbilities(client: pg.PoolClient, characterId: string, abilities: CharacterAbility[]): Promise<void> {
  await client.query('DELETE FROM character_abilities WHERE character_id = $1', [characterId]);
  for (const row of abilities) {
    await client.query(
      'INSERT INTO character_abilities (character_id, ability_key, score) VALUES ($1, $2, $3)',
      [characterId, row.key, Math.max(1, Number(row.score) || 10)]
    );
  }
}

async function replaceResources(client: pg.PoolClient, characterId: string, resources: CharacterResource[]): Promise<void> {
  await client.query('DELETE FROM character_resources WHERE character_id = $1', [characterId]);
  for (const [index, row] of resources.entries()) {
    const maxValue = Math.max(0, Number(row.maxValue) || 0);
    await client.query(
      `
        INSERT INTO character_resources (character_id, resource_key, label, current_value, max_value, sort_order)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [characterId, row.key, row.label, clampResource(row.currentValue, maxValue), maxValue, index]
    );
  }
}

async function replaceInventory(client: pg.PoolClient, characterId: string, inventory: InventoryItem[]): Promise<void> {
  const retainedIds = inventory.filter((row) => row.name.trim() && Number(row.quantity) > 0).map((row) => row.id).filter(Boolean);
  await client.query('DELETE FROM character_inventory_items WHERE character_id = $1 AND NOT (id = ANY($2::uuid[]))', [characterId, retainedIds]);
  for (const [index, row] of inventory.entries()) {
    if (!row.name.trim() || Number(row.quantity) <= 0) continue;
    await client.query(
      `
        INSERT INTO character_inventory_items
          (id, character_id, name, category, location, quantity, equipped, is_equipment, ac_bonus, to_hit_bonus, damage_bonus, attack_ability, proficient, damage_rolls, effects, str_bonus, dex_bonus, con_bonus, int_bonus, wis_bonus, cha_bonus, notes, sort_order, source_content_id, attuned)
        VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
        ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, category=EXCLUDED.category, location=EXCLUDED.location,
          quantity=EXCLUDED.quantity, equipped=EXCLUDED.equipped, is_equipment=EXCLUDED.is_equipment,
          ac_bonus=EXCLUDED.ac_bonus, to_hit_bonus=EXCLUDED.to_hit_bonus, damage_bonus=EXCLUDED.damage_bonus,
          attack_ability=EXCLUDED.attack_ability, proficient=EXCLUDED.proficient, damage_rolls=EXCLUDED.damage_rolls,
          effects=EXCLUDED.effects, notes=EXCLUDED.notes, sort_order=EXCLUDED.sort_order,
          source_content_id=EXCLUDED.source_content_id, attuned=EXCLUDED.attuned
        WHERE character_inventory_items.character_id = EXCLUDED.character_id
      `,
      [
        row.id || null,
        characterId,
        row.name,
        row.category || 'gear',
        row.location || (row.equipped ? 'equipped' : 'backpack'),
        Math.max(0, Number(row.quantity) || 1),
        row.location === 'equipped' || row.equipped,
        row.isEquipment,
        Number(row.acBonus) || 0,
        Number(row.toHitBonus) || 0,
        Number(row.damageBonus) || 0,
        abilityKeys.includes(row.attackAbility) ? row.attackAbility : 'str',
        row.proficient ?? true,
        row.damageRolls || '',
        row.effects || '',
        Number(row.abilityBonuses.str) || 0,
        Number(row.abilityBonuses.dex) || 0,
        Number(row.abilityBonuses.con) || 0,
        Number(row.abilityBonuses.int) || 0,
        Number(row.abilityBonuses.wis) || 0,
        Number(row.abilityBonuses.cha) || 0,
        row.notes || '',
        index,
        row.sourceContentId || null,
        row.attuned || false
      ]
    );
  }
}

async function replaceAttacks(client: pg.PoolClient, characterId: string, attacks: CharacterAttack[]): Promise<void> {
  await client.query('DELETE FROM character_attacks WHERE character_id = $1', [characterId]);
  for (const [index, row] of attacks.entries()) {
    if (!row.name.trim()) continue;
    await client.query(
      'INSERT INTO character_attacks (character_id, name, attack_ability, proficient, damage_dice, notes, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [characterId, row.name, row.attackAbility, row.proficient, row.damageDice, row.notes, index]
    );
  }
}

async function replaceNotes(client: pg.PoolClient, characterId: string, notes: CharacterNote[]): Promise<void> {
  await client.query('DELETE FROM character_notes WHERE character_id = $1', [characterId]);
  for (const [index, row] of notes.entries()) {
    await client.query(
      'INSERT INTO character_notes (character_id, note_key, title, content, sort_order) VALUES ($1, $2, $3, $4, $5)',
      [characterId, row.key, row.title, row.content, index]
    );
  }
}

async function replaceProficiencies(
  client: pg.PoolClient,
  characterId: string,
  proficiencies: Array<{ type: string; key: string }>
): Promise<void> {
  await client.query('DELETE FROM character_proficiencies WHERE character_id = $1', [characterId]);
  const validTypes = new Set(['saving_throw', 'skill', 'weapon']);
  const seen = new Set<string>();
  for (const row of proficiencies) {
    const type = row.type.trim();
    const key = row.key.trim();
    const identity = `${type}:${key}`;
    if (!validTypes.has(type) || !key || seen.has(identity)) continue;
    seen.add(identity);
    await client.query(
      'INSERT INTO character_proficiencies (character_id, proficiency_type, proficiency_key) VALUES ($1, $2, $3)',
      [characterId, type, key]
    );
  }
}

async function replaceActiveEffects(client: pg.PoolClient, characterId: string, effectKeys: string[]): Promise<void> {
  const uniqueKeys = [...new Set(effectKeys.map((key) => key.trim()).filter(Boolean))];
  await client.query(`DELETE FROM active_character_effects active WHERE character_id=$1
    AND NOT EXISTS (SELECT 1 FROM effect_definitions effect WHERE effect.id=active.effect_id AND effect.effect_key=ANY($2::text[]))`,
    [characterId, uniqueKeys]);
  for (const key of uniqueKeys) {
    const effect=await client.query<{id:string}>('SELECT id FROM effect_definitions WHERE effect_key=$1 AND is_archived=false',[key]);
    if(effect.rowCount){
      const active=await client.query('SELECT 1 FROM active_character_effects WHERE character_id=$1 AND effect_id=$2',[characterId,effect.rows[0].id]);
      if(!active.rowCount)await applyCharacterEffect(client,characterId,effect.rows[0].id);
    }
  }
}

async function setExhaustionLevel(client: pg.PoolClient, characterId: string, level: number): Promise<void> {
  const exhaustionLevel = Math.min(6, Math.max(0, Number(level) || 0));
  await client.query(
    `
      INSERT INTO character_exhaustion (character_id, exhaustion_level, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (character_id) DO UPDATE
      SET exhaustion_level = EXCLUDED.exhaustion_level,
          updated_at = now()
    `,
    [characterId, exhaustionLevel]
  );
}

function parseClasses(form: FormData): CharacterClass[] {
  const names = form.getAll('className').map((value) => String(value).trim());
  const levels = form.getAll('classLevel').map(Number);
  const subclasses = form.getAll('subclassName').map(String);
  const abilities = form.getAll('classSpellcastingAbility').map(String);
  if (!names.length) return [{ className: 'Fighter', level: Math.max(1, Number(form.get('level')) || 1) }];
  return names.map((className, index) => ({
    className: className || 'Fighter', level: Math.max(1, levels[index] || 1), subclassName: subclasses[index] || '',
    spellcastingAbility: (abilities[index] || null) as AbilityKey | null
  }));
}

function parseAbilities(form: FormData): CharacterAbility[] {
  return abilityKeys.map((key) => ({ key, score: Math.max(1, Number(form.get(`ability_${key}`)) || 10) }));
}

function parseResources(form: FormData): CharacterResource[] {
  return [
    {
      key: 'hp',
      label: 'HP',
      currentValue: Number(form.get('hpCurrent')) || 0,
      maxValue: Number(form.get('hpMax')) || 0
    },
    {
      key: 'temp_hp',
      label: 'Temp HP',
      currentValue: Number(form.get('tempHp')) || 0,
      maxValue: Number(form.get('tempHp')) || 0
    },
    {
      key: 'inspiration',
      label: 'Inspiration',
      currentValue: Math.max(0, Number(form.get('inspiration')) || 0),
      maxValue: Math.max(1, Number(form.get('inspiration')) || 0)
    }
  ];
}

function parseInventory(form: FormData): InventoryItem[] {
  const ids = form.getAll('inventoryId').map(String);
  const names = form.getAll('inventoryName').map((value) => String(value).trim());
  const categories = form.getAll('inventoryCategory').map(String);
  const locations = form.getAll('inventoryLocation').map(String);
  const quantities = form.getAll('inventoryQuantity').map(Number);
  const equipped = form.getAll('inventoryEquipped').map((value) => String(value) === 'true');
  const isEquipment = form.getAll('inventoryIsEquipment').map((value) => String(value) === 'true');
  const acBonuses = form.getAll('inventoryAcBonus').map(Number);
  const toHitBonuses = form.getAll('inventoryToHitBonus').map(Number);
  const damageBonuses = form.getAll('inventoryDamageBonus').map(Number);
  const attackAbilities = form.getAll('inventoryAttackAbility').map(String);
  const proficientValues = form.getAll('inventoryProficient').map((value) => String(value) === 'true');
  const damageRolls = form.getAll('inventoryDamageRolls').map(String);
  const effects = form.getAll('inventoryEffects').map(String);
  const notes = form.getAll('inventoryNotes').map(String);
  const sourceContentIds = form.getAll('inventorySourceContentId').map(String);
  const attunedValues = form.getAll('inventoryAttuned').map((value) => String(value) === 'true');

  return names
    .map((name, index) => {
      const location = normalizeInventoryLocation(locations[index], equipped[index]);
      return {
        id: ids[index] || undefined,
        name,
        category: categories[index] || 'gear',
        location,
        quantity: Math.max(0, quantities[index] || 0),
        equipped: location === 'equipped',
        isEquipment: Boolean(isEquipment[index]),
        acBonus: acBonuses[index] || 0,
        toHitBonus: toHitBonuses[index] || 0,
        damageBonus: damageBonuses[index] || 0,
        attackAbility: abilityKeys.includes(attackAbilities[index] as AbilityKey) ? (attackAbilities[index] as AbilityKey) : 'str',
        proficient: proficientValues[index] ?? true,
        sourceContentId: sourceContentIds[index] || null,
        attuned: attunedValues[index] || false,
        damageRolls: damageRolls[index] || '',
        effects: effects[index] || '',
        abilityBonuses: {},
        notes: notes[index] || ''
      };
    })
    .filter((item) => item.name.trim() && item.quantity > 0);
}

function parseProficiencies(form: FormData): Array<{ type: string; key: string }> {
  return [
    ...form.getAll('savingThrowProficiency').map((value) => ({ type: 'saving_throw', key: String(value) })),
    ...form.getAll('skillProficiency').map((value) => ({ type: 'skill', key: String(value) })),
    ...form.getAll('weaponProficiency').map((value) => ({ type: 'weapon', key: String(value) }))
  ];
}

function normalizeInventoryLocation(value: string | undefined, equipped: boolean): 'equipped' | 'backpack' | 'misc' {
  if (value === 'equipped' || value === 'backpack' || value === 'misc') return value;
  return equipped ? 'equipped' : 'backpack';
}

function parseAttacks(form: FormData): CharacterAttack[] {
  return [
    {
      name: String(form.get('attackName') || '').trim(),
      attackAbility: (String(form.get('attackAbility') || 'str') as AbilityKey) || 'str',
      proficient: !!form.get('attackProficient'),
      damageDice: String(form.get('attackDamageDice') || '').trim(),
      notes: String(form.get('attackNotes') || '')
    }
  ];
}

function parseMetadata(form: FormData): Record<string, string> {
  return Object.fromEntries(metadataFields.map((field) => [field, String(form.get(field) || '').trim()]));
}

function parseActiveEffectKeys(form: FormData): string[] {
  return form.getAll('activeEffectKey').map((value) => String(value).trim()).filter(Boolean);
}

function parseNotes(form: FormData): CharacterNote[] {
  return [
    { key: 'attacks', title: 'Attacks & Spellcasting', content: String(form.get('attacksNote') || '') },
    { key: 'spellcasting', title: 'Spellcasting Notes', content: String(form.get('spellcastingNote') || '') },
    { key: 'battle_notes', title: 'Battle Notes', content: String(form.get('battleNotes') || '') },
    { key: 'saving_throws', title: 'Saving Throws', content: String(form.get('savingThrowsNote') || '') },
    { key: 'skills', title: 'Skills', content: String(form.get('skillsNote') || '') },
    { key: 'conditions', title: 'Conditions & Effects', content: String(form.get('conditionsNote') || '') },
    { key: 'spell_slots', title: 'Spell Slots', content: String(form.get('spellSlotsNote') || '') },
    { key: 'prepared_spells', title: 'Prepared Spells', content: String(form.get('preparedSpellsNote') || '') },
    { key: 'class_features', title: 'Class Features', content: String(form.get('classFeaturesNote') || '') },
    { key: 'feats', title: 'Feats', content: String(form.get('featsNote') || '') },
    { key: 'traits', title: 'Traits', content: String(form.get('traitsNote') || '') },
    { key: 'usable_traits', title: 'Usable Traits', content: String(form.get('usableTraitsNote') || '') },
    { key: 'proficiencies_languages', title: 'Proficiencies & Languages', content: String(form.get('proficienciesLanguagesNote') || '') },
    { key: 'limited_uses', title: 'Limited Uses', content: String(form.get('limitedUsesNote') || '') },
    { key: 'treasure', title: 'Treasure & Valuables', content: String(form.get('treasureNote') || '') },
    { key: 'general_inventory', title: 'General Inventory', content: String(form.get('generalInventoryNote') || '') },
    { key: 'personality', title: 'Personality Traits', content: String(form.get('personalityNote') || '') },
    { key: 'ideals', title: 'Ideals', content: String(form.get('idealsNote') || '') },
    { key: 'bonds', title: 'Bonds', content: String(form.get('bondsNote') || '') },
    { key: 'flaws', title: 'Flaws', content: String(form.get('flawsNote') || '') },
    { key: 'backstory', title: 'Backstory', content: String(form.get('backstoryNote') || '') },
    { key: 'allies_organizations', title: 'Allies & Organizations', content: String(form.get('alliesOrganizationsNote') || '') },
    { key: 'appearance', title: 'Appearance', content: String(form.get('appearanceNote') || '') },
    { key: 'additional_notes', title: 'Additional Notes', content: String(form.get('additionalNotesNote') || '') }
  ];
}
