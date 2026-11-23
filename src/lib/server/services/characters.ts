import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { abilityKeys, clampResource } from '$lib/rules/dnd5e';
import { readStatOverrides, type StatOverrides } from '$lib/rules/characterStats';
import { getCombatClock, listCharacterContent, listSpellSlots, syncCharacterSpellSlots } from '$lib/server/services/catalogue';
import { resolveCharacterModifierSources } from '$lib/server/services/rule-engine';
import { applyCharacterEffect } from '$lib/server/services/effects';
import { readEffectMetadata, substituteParams } from '$lib/rules/effectParams';
import { getActiveEncounterForCharacter } from '$lib/server/services/encounters';
import { logCombatEvent } from '$lib/server/services/combatLog';
import { assertCanEditCharacter, getCharacterAccess, type CharacterAccess } from '$lib/server/services/access';
import { cachedReference } from '$lib/server/cache/referenceData';
import { costSummary, parseCostJson } from '$lib/rules/cost';
import { getCharacterPools, listPoolDefinitions, poolContextFor } from '$lib/server/services/resource-pools';
import { characterProfile, getTurnView } from '$lib/server/services/turn-state';
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
  campaign_id: string | null;
  campaign_name: string | null;
  party_active: boolean;
  sheet_version: number;
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

// armorClass/initiative/speed/hitDice/passivePerception/spellSaveDc/spellAttackBonus used to be
// listed here, written on every save as write-only derived copies of the computed sheet values.
// Nothing ever read them back (grep-verified across src/, static/vtt-app/, vtt/) - every consumer
// recomputes live via resolveCharacterStats()/characterStatsFor(). They're deliberately not
// listed below any more, so they stop being written; old values may still linger in existing
// metadata_json rows and version snapshots, but must never be treated as authoritative.
// spellcastingAbility stays - it IS read (see meta('spellcastingAbility') and
// resolveSpellcastingAbility()).
const metadataFields = [
  'race',
  'alignment',
  'playerName',
  'experiencePoints',
  'deathSaveSuccesses',
  'deathSaveFailures',
  'spellcastingAbility',
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

function mapCharacterRow(row: CharacterRow, detail: Omit<CharacterDetail, keyof CharacterRow | 'ownerUserId' | 'systemKey' | 'metadata' | 'updatedAt' | 'campaignId' | 'campaignName' | 'partyActive' | 'sheetVersion'>): CharacterDetail {
  return {
    id: row.id,
    ownerUserId: row.owner_user_id,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    partyActive: row.party_active,
    sheetVersion: row.sheet_version,
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
      SELECT c.id, c.owner_user_id, c.name, c.ancestry, c.background, c.system_key, c.metadata_json, c.updated_at,
             c.campaign_id, cp.name AS campaign_name, c.party_active, c.sheet_version
      FROM characters c
      LEFT JOIN campaigns cp ON cp.id = c.campaign_id
      WHERE c.owner_user_id = $1
      ORDER BY c.updated_at DESC
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
      campaignId: row.campaign_id,
      campaignName: row.campaign_name,
      partyActive: row.party_active,
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

async function loadCharacterDetail(row: CharacterRow): Promise<CharacterDetail> {
  const characterId = row.id;
  const resolvedModifiers = await resolveCharacterModifierSources(characterId);
  const classes = await getClasses(characterId);
  const abilities = await getAbilities(characterId);
  const poolDefinitions = await listPoolDefinitions({ includeArchived: true });
  const poolLabels = Object.fromEntries(poolDefinitions.map((pool) => [pool.key, pool.label]));
  const poolCtx = poolContextFor(classes, abilities, row.metadata_json);
  const pools = await getCharacterPools({ query }, characterId, poolDefinitions, resolvedModifiers.sources, poolCtx);
  // Reuses the sources and context already loaded above, so the turn view costs the profile and turn-row queries only.
  const turn = await getTurnView({ query }, characterId, { profile: await characterProfile({ query }, characterId), sources: resolvedModifiers.sources, ctx: poolCtx });

  return mapCharacterRow(row, {
    classes,
    abilities,
    pools,
    turn,
    actionEconomy: turn.profileKey,
    resources: await getResources(characterId),
    inventory: await getInventory(characterId, poolLabels, turn.profileKey),
    attacks: await getAttacks(characterId),
    notes: await getNotes(characterId),
    proficiencies: await getProficiencies(characterId),
    activeEffects: await getActiveEffects(characterId),
    modifierSources: resolvedModifiers.sources,
    modifierAudit: resolvedModifiers.audit,
    availableEffects: await listEffectDefinitions(),
    exhaustionLevel: await getExhaustionLevel(characterId),
    content: await listCharacterContent(characterId, poolLabels, turn.profileKey),
    spellSlots: await listSpellSlots(characterId),
    combatClock: await getCombatClock(characterId)
  });
}

// Loads the full sheet for anyone who may VIEW it: the owner, any member of the character's
// (live) campaign, or a site admin. Callers that show editing controls must also check
// access.canEdit (the sheet page turns it into a read-only sheet). Everything that loads a sheet
// (the VTT pull-through and the encounter page included) goes through here, so they all follow;
// every write path still has its own edit/act check.
export async function getCharacter(userId: string, characterId: string): Promise<CharacterDetail | null> {
  return (await getCharacterWithAccess(userId, characterId))?.character ?? null;
}

// Same as getCharacter, but also hands back the access flags it already worked out, so the sheet's
// load() does not run the access query a second time.
export async function getCharacterWithAccess(userId: string, characterId: string): Promise<{ character: CharacterDetail; access: CharacterAccess } | null> {
  const access = await getCharacterAccess({ query }, userId, characterId);
  if (!access?.canView) return null;
  const result = await query<CharacterRow>(
    `
      SELECT c.id, c.owner_user_id, c.name, c.ancestry, c.background, c.system_key, c.metadata_json, c.updated_at,
             c.campaign_id, cp.name AS campaign_name, c.party_active, c.sheet_version
      FROM characters c
      LEFT JOIN campaigns cp ON cp.id = c.campaign_id
      WHERE c.id = $1
    `,
    [characterId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { character: await loadCharacterDetail(row), access };
}

// Same computed character detail as getCharacter, but without the owner
// check - for VTT combat rolls only, never the main character sheet or
// anything that mutates state (spell-slot spend etc. stays gated behind
// assertCharacterOwner, a separate and deliberately stricter check). A GM
// rolling a weapon attack for a player's token - e.g. the player stepped
// away - is a pure dice-roll read, and per this app's product philosophy
// ("campaign members can view/interact with all campaign sheets, no
// ownership locks") shouldn't 404 just because the roll happens under the
// GM's own login rather than the character's owner_user_id.
export async function getCharacterForRoll(characterId: string): Promise<CharacterDetail | null> {
  const result = await query<CharacterRow>(
    `
      SELECT c.id, c.owner_user_id, c.name, c.ancestry, c.background, c.system_key, c.metadata_json, c.updated_at,
             c.campaign_id, cp.name AS campaign_name, c.party_active, c.sheet_version
      FROM characters c
      LEFT JOIN campaigns cp ON cp.id = c.campaign_id
      WHERE c.id = $1
    `,
    [characterId]
  );
  const row = result.rows[0];
  if (!row) return null;
  return loadCharacterDetail(row);
}

// Shared, admin-edited-only reference data - see the module-level
// listEffectDefinitions split below for why this is a throwing inner loader
// plus an outer try/catch wrapper rather than one function.
async function loadItemCategories(): Promise<ItemCategory[]> {
  const result = await query<{ key: string; label: string }>(
    'SELECT key, label FROM item_categories ORDER BY sort_order ASC, label ASC'
  );
  return result.rows;
}

export async function listItemCategories(): Promise<ItemCategory[]> {
  try {
    // structuredClone so a caller mutating the returned array/objects can't
    // corrupt the cached copy for every other caller until the TTL expires.
    return structuredClone(await cachedReference('item-categories', loadItemCategories));
  } catch {
    // The fallback list must never be cached - see loadItemCategories above;
    // cachedReference only ever stores a *resolved* promise, so returning
    // this list here (outside cachedReference) rather than caching it is
    // deliberate.
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

// Thrown by updateCharacter when the sheet being saved is older than what is in the database (the
// owner, a DM or an admin saved in between). The route turns it into a 409 and the sheet asks the
// user to reload. Nothing has been written when it is thrown.
export class StaleSheetError extends Error {
  constructor() {
    super('Someone else saved this sheet. Reload to see their changes.');
    this.name = 'StaleSheetError';
  }
}

// Whole-sheet save. Owner, campaign DM/co-DM and site admin may call it (assertCanEditCharacter).
// Returns the sheet's new version number so the sheet can carry it into its next save.
//
// Stale-save guard: the sheet posts the `sheetVersion` it loaded. characters.sheet_version is bumped
// only by whole-sheet writes (this and a version restore), so button actions, forage finds and VTT
// HP changes never make an open sheet refuse its next Save. A missing field (a tab opened before
// this shipped) skips the check.
export async function updateCharacter(userId: string, characterId: string, form: FormData, summary: string): Promise<number> {
  const resources = parseResources(form);
  let newHp = resources.find((r) => r.key === 'hp')?.currentValue ?? null;
  let previousHp: number | null = null;
  let characterName = '';

  let newVersion = 0;
  await withTransaction(async (client) => {
    await assertCanEditCharacter(client, userId, characterId);
    // FOR UPDATE: two simultaneous saves queue here, so the second sees the first's new version.
    const current = await client.query<{ sheet_version: number }>('SELECT sheet_version FROM characters WHERE id = $1 FOR UPDATE', [characterId]);
    const loadedRaw = String(form.get('sheetVersion') ?? '').trim();
    if (loadedRaw !== '' && Number(loadedRaw) !== current.rows[0]?.sheet_version) throw new StaleSheetError();

    // Read the pre-update HP before replaceResources overwrites it, so a
    // change can be reported as a delta ("takes 12 damage") rather than just
    // an absolute overwrite - see the combat-log write below.
    const prevHpRow = await client.query<{ current_value: number }>(
      `SELECT current_value FROM character_resources WHERE character_id = $1 AND resource_key = 'hp' FOR UPDATE`,
      [characterId]
    );
    previousHp = prevHpRow.rows[0]?.current_value ?? null;
    // The two reads above lock the hp / temp_hp rows (FOR UPDATE, after the characters row, the usual order): the
    // action engine and rests write these rows without locking the characters row, so the lock is what keeps the
    // value we preserve from changing before we write.
    // Typing a value equal to the stale baseline counts as unedited (indistinguishable from not touching it; accepted).
    // Decks unit 6: HP, temp HP and coin are also changed from outside the sheet (a deck draw, the VTT), so a
    // value the user did not edit keeps whatever the database holds now instead of the sheet's stale copy.
    // No baseline posted (an old tab, a script) = the old behaviour, everything posted is written.
    const resourceBaseline = parseResourceBaseline(form);
    if (resourceBaseline) {
      const prevTempRow = await client.query<{ current_value: number }>(
        `SELECT current_value FROM character_resources WHERE character_id = $1 AND resource_key = 'temp_hp' FOR UPDATE`, [characterId]);
      keepUneditedResources(resources, resourceBaseline, { hp: previousHp, tempHp: prevTempRow.rows[0]?.current_value ?? null });
      newHp = resources.find((r) => r.key === 'hp')?.currentValue ?? null; // so an unedited HP is never logged as a change
    }
    characterName = String(form.get('name') || '').trim() || 'A character';

    const overrides = parseStatOverridesField(form);
    const metadataPatch: Record<string, unknown> = { ...parseMetadata(form), ...(overrides !== undefined ? { statOverrides: overrides } : {}) };
    if (resourceBaseline) keepUneditedCoins(metadataPatch, resourceBaseline);

    const updated = await client.query<{ sheet_version: number }>(
      `
        UPDATE characters
        SET name = $1,
            ancestry = $2,
            background = $3,
            metadata_json = metadata_json || $4::jsonb,
            updated_at = now(),
            sheet_version = sheet_version + 1
        WHERE id = $5
        RETURNING sheet_version
      `,
      [
        characterName,
        String(form.get('ancestry') || '').trim(),
        String(form.get('background') || '').trim(),
        JSON.stringify(metadataPatch),
        characterId
      ]
    );
    newVersion = updated.rows[0].sheet_version;

    await replaceClasses(client, characterId, parseClasses(form));
    await replaceAbilities(client, characterId, parseAbilities(form));
    await replaceSheetResources(client, characterId, resources);
    // Changes only when the sheet sent its loaded baseline (see saveInventoryChanges); otherwise the
    // old full replace.
    const inventoryBaseline = parseInventoryBaseline(form);
    if (inventoryBaseline) await saveInventoryChanges(client, characterId, parseInventory(form), inventoryBaseline);
    else await replaceInventory(client, characterId, parseInventory(form));
    await replaceAttacks(client, characterId, parseAttacks(form));
    await replaceNotes(client, characterId, parseNotes(form));
    await replaceProficiencies(client, characterId, parseProficiencies(form));
    await replaceActiveEffects(client, characterId, parseActiveEffectKeys(form));
    await setExhaustionLevel(client, characterId, Number(form.get('exhaustionLevel')) || 0);
    await createVersionWithClient(client, characterId, userId, summary);
  });
  await syncCharacterSpellSlots(userId, characterId);

  // Combat-log write for a plain sheet HP edit - only fires if the character
  // has joined an active encounter (see getActiveEncounterForCharacter); an
  // untouched HP value or no active encounter means nothing to log, which
  // keeps autosave ticks silent by construction.
  if (previousHp !== null && newHp !== null && previousHp !== newHp) {
    const delta = previousHp - newHp;
    const encounterId = await getActiveEncounterForCharacter(characterId);
    if (encounterId) {
      const message = delta > 0 ? `${characterName} takes ${delta} damage.` : `${characterName} heals ${-delta} HP.`;
      await logCombatEvent(encounterId, message, { type: 'sheet_hp_change', delta });
    }
  }
  return newVersion;
}

// Anyone who can view the sheet can see its version list; only editors may restore (that has its
// own edit check in restoreCharacterVersion).
export async function listVersions(userId: string, characterId: string): Promise<CharacterVersion[]> {
  const access = await getCharacterAccess({ query }, userId, characterId);
  if (!access?.canView) return [];
  const result = await query<{
    id: string;
    character_id: string;
    created_at: string;
    change_summary: string;
  }>(
    `
      SELECT id, character_id, created_at, change_summary
      FROM character_versions
      WHERE character_id = $1
      ORDER BY created_at DESC
      LIMIT 20
    `,
    [characterId]
  );

  return result.rows.map((row) => ({
    id: row.id,
    characterId: row.character_id,
    createdAt: row.created_at,
    changeSummary: row.change_summary
  }));
}

// Owner, campaign DM/co-DM or site admin (assertCanEditCharacter). The snapshot is looked up by
// character id only; the edit check above is what gates it. A restore is a whole-sheet write, so
// applySnapshot bumps sheet_version too.
export async function restoreCharacterVersion(userId: string, characterId: string, versionId: string): Promise<void> {
  return await withTransaction(async (client) => {
    await assertCanEditCharacter(client, userId, characterId);
    const version = await client.query<{
      character_id: string;
      created_at: string;
      snapshot_json: CharacterSnapshot;
    }>(
      `
        SELECT character_id, created_at, snapshot_json
        FROM character_versions
        WHERE id = $1 AND character_id = $2
      `,
      [versionId, characterId]
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
      SELECT regexp_replace(cd.content_key, '^condition:', '') AS effect_key, active_character_effects.remaining_rounds, active_character_effects.metadata_json,
        active_character_effects.source_content_instance_id, active_character_effects.expiry_boundary,
        active_character_effects.application_key,active_character_effects.source_key
      FROM active_character_effects
      JOIN content_definitions cd ON cd.id = active_character_effects.container_id
      WHERE active_character_effects.character_id = $1
      ORDER BY CASE WHEN cd.metadata_json->>'sortOrder' ~ '^-?[0-9]{1,9}$' THEN (cd.metadata_json->>'sortOrder')::int END NULLS LAST, cd.name
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
          updated_at = now(),
          sheet_version = sheet_version + 1
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
  // Restored effects keep metadata_json (params, label) but not source_character_id: snapshots don't store it (accepted).
  for (const row of snapshot.active_effects ?? []) {
    await client.query(`INSERT INTO active_character_effects(character_id,container_id,remaining_rounds,metadata_json,
      source_content_instance_id,expiry_boundary,application_key,source_key)
      SELECT $1,cd.id,$2,$3,$4,$5,COALESCE($6::uuid,gen_random_uuid()),$7
      FROM content_definitions cd
      WHERE cd.content_type='condition' AND cd.content_key='condition:'||$8`,
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
    // pool:* rows (character resource pools) are not sheet fields: they load as detail.pools.
    `SELECT resource_key, label, current_value, max_value FROM character_resources WHERE character_id = $1 AND resource_key NOT LIKE 'pool:%' ORDER BY sort_order ASC`,
    [characterId]
  );
  return result.rows.map((row) => ({
    key: row.resource_key,
    label: row.label,
    currentValue: row.current_value,
    maxValue: row.max_value
  }));
}

async function getInventory(characterId: string, knownPoolLabels?: Record<string, string>, profileKey?: string): Promise<InventoryItem[]> {
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
    source_cost_json: unknown;
  }>('SELECT i.*, c.cost_json AS source_cost_json FROM character_inventory_items i LEFT JOIN content_definitions c ON c.id = i.source_content_id WHERE i.character_id = $1 ORDER BY i.sort_order ASC', [characterId]);
  const poolLabels = knownPoolLabels ?? Object.fromEntries((await listPoolDefinitions({ includeArchived: true })).map((pool) => [pool.key, pool.label]));
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
    // Only an explicit cost shows (the default item cost, one of itself, would be noise).
    costSummary: (() => { const parsed = parseCostJson(row.source_cost_json, { stored: true }); return parsed.entries?.length ? costSummary(parsed.entries, poolLabels, profileKey) : undefined; })(),
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

// db-traffic-reduction Phase 2: this used to run twice per getCharacter call
// (once with includeArchived=false for availableEffects, once with true
// inside getActiveEffects) - each time re-reading every condition Container,
// including the archived SRD imports with their full descriptions. Split
// into a throwing inner loader (cached, keyed by includeArchived so the two
// call shapes don't collide) and an outer wrapper that keeps the original
// try/catch -> [] behaviour. A transient DB error must not get cached as an
// empty list, hence the split rather than caching the wrapper's return value
// directly.
async function loadEffectDefinitions(includeArchived: boolean): Promise<EffectDefinition[]> {
  // Primary path: conditions as unified Containers in content_definitions.
  const effects = await query<{
    id: string;
    effect_key: string;
    name: string;
    description: string;
    duration_type: string;
    duration_rounds: number | null;
    requires_concentration: boolean;
    source_kind: string;
    is_condition: boolean;
  }>(
    `SELECT cd.id, REPLACE(cd.content_key, 'condition:', '') AS effect_key, cd.name, cd.description,
      cd.duration_type, cd.duration_rounds, cd.requires_concentration, cd.source_kind,
      COALESCE(cd.metadata_json->>'isCondition', 'false') = 'true' AS is_condition
     FROM content_definitions cd
     WHERE cd.content_type='condition' AND ($1::boolean OR cd.is_archived=false)
     ORDER BY cd.name ASC`,
    [includeArchived]
  );

  const modifiers = await listEffectModifiers();
  const modifiersByEffect = new Map<string, EffectModifier[]>();
  for (const row of modifiers) {
    const list = modifiersByEffect.get(row.effect_id) ?? [];
    list.push({
      target: row.target, modifierType: row.modifier_type, label: '',
      valueExpression: row.value_expression || '',
      defaultValueExpression: row.default_value_expression || '',
      valueOverrideExpression: row.value_override_expression || '',
      conditionExpression: row.condition_expression || '', priority: row.priority
    });
    modifiersByEffect.set(row.effect_id, list);
  }

  return effects.rows.map((row) => ({
    id: row.id,
    key: row.effect_key,
    name: row.name,
    sourceType: row.source_kind,
    sourceRef: '',
    sourceName: row.name,
    description: row.description || '',
    durationType: row.duration_type || '',
    durationRounds: row.duration_rounds,
    requiresConcentration: row.requires_concentration,
    isCondition: row.is_condition,
    isSelectable: true,
    modifiers: modifiersByEffect.get(row.id) ?? []
  }));
}

async function listEffectDefinitions(includeArchived = false): Promise<EffectDefinition[]> {
  try {
    // structuredClone so a caller mutating the returned array/objects (e.g.
    // pushing into .modifiers) can't corrupt the cached copy for every other
    // caller until the TTL expires.
    return structuredClone(
      await cachedReference(`effects:${includeArchived}`, () => loadEffectDefinitions(includeArchived))
    );
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
  // Query via content_modifier_links for condition Containers.
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
    `SELECT cml.content_id AS effect_id,
       md.target, md.modifier_type, COALESCE(md.default_value_expression,'') AS default_value_expression,
       COALESCE(cml.value_override_expression,'') AS value_override_expression,
       COALESCE(cml.value_override_expression, md.default_value_expression,'') AS value_expression,
       COALESCE(cml.condition_expression,'') AS condition_expression, cml.priority
     FROM content_modifier_links cml
     JOIN modifier_definitions md ON md.id=cml.modifier_id
     JOIN content_definitions cd ON cd.id=cml.content_id AND cd.content_type='condition'
     ORDER BY cml.priority ASC, md.target ASC`
  );
  return result.rows;
}

async function getActiveEffects(characterId: string): Promise<CharacterDetail['activeEffects']> {
  const definitions = await listEffectDefinitions(true);
  const byId = new Map(definitions.map((d) => [d.id, d]));
  try {
    const active = await query<{ id: string; container_id: string; remaining_rounds: number | null; metadata_json: unknown }>(
      `-- Direct active effects (primary: container_id)
       SELECT id::text, container_id::text AS container_id, remaining_rounds, metadata_json
       FROM active_character_effects
       WHERE character_id=$1 AND container_id IS NOT NULL
       UNION ALL
       -- Conditions granted by active content instances
       SELECT 'content:' || i.id || ':' || cg.id, cg.granted_content_id::text, NULL, NULL::jsonb
       FROM character_content_instances i
       JOIN content_definitions c ON c.id=i.content_id
       JOIN content_grants cg ON cg.source_content_id=i.content_id
       JOIN content_definitions granted ON granted.id=cg.granted_content_id AND granted.content_type='condition'
       WHERE i.character_id=$1 AND i.is_active=true AND c.content_type <> 'item'
         AND cg.activation_type IN ('carried','equipped','attuned','manual')
       UNION ALL
       -- Conditions granted by equipped/carried inventory items
       SELECT 'item:' || inv.id || ':' || cg.id, cg.granted_content_id::text, NULL, NULL::jsonb
       FROM character_inventory_items inv
       JOIN content_grants cg ON cg.source_content_id=inv.source_content_id
       JOIN content_definitions granted ON granted.id=cg.granted_content_id AND granted.content_type='condition'
       WHERE inv.character_id=$1 AND (
         cg.activation_type='carried'
         OR (cg.activation_type='equipped' AND inv.equipped)
         OR (cg.activation_type='attuned' AND inv.attuned)
       )
       UNION ALL
       -- Conditions granted transitively (item grants a content, that content grants a condition)
       SELECT 'grant:' || inv.id || ':' || cg2.id, cg2.granted_content_id::text, NULL, NULL::jsonb
       FROM character_inventory_items inv
       JOIN content_grants cg1 ON cg1.source_content_id=inv.source_content_id
       JOIN content_grants cg2 ON cg2.source_content_id=cg1.granted_content_id
       JOIN content_definitions granted ON granted.id=cg2.granted_content_id AND granted.content_type='condition'
       WHERE inv.character_id=$1 AND (
         cg1.activation_type='carried'
         OR (cg1.activation_type='equipped' AND inv.equipped)
         OR (cg1.activation_type='attuned' AND inv.attuned)
       )`,
      [characterId]
    );

    return active.rows
      .map((row) => {
        const definition = byId.get(row.container_id);
        if (!definition) return null;
        // Applied-instance params/label (e.g. a deck card's AC value): show the label and the resolved value.
        const { params, sourceLabel } = readEffectMetadata(row.metadata_json);
        const hasParams = Object.keys(params).length > 0;
        return {
          id: row.id,
          effectId: definition.id,
          effectKey: definition.key,
          name: sourceLabel ? `${definition.name} (${sourceLabel})` : definition.name,
          sourceType: definition.sourceType,
          sourceName: definition.sourceName,
          description: definition.description,
          durationType: definition.durationType,
          requiresConcentration: definition.requiresConcentration,
          isCondition: definition.isCondition,
          isSelectable: definition.isSelectable,
          remainingRounds: row.remaining_rounds,
          modifiers: hasParams
            ? definition.modifiers.map((m) => ({
              ...m,
              valueExpression: substituteParams(m.valueExpression, params),
              valueOverrideExpression: substituteParams(m.valueOverrideExpression, params)
            }))
            : definition.modifiers
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

// The whole-sheet Save owns only hp / temp_hp / inspiration / hit_dice_N. It must leave the pool:*
// rows (cost-engine resource pools) alone; creating a character and restoring a snapshot still use
// the full replace below, because a restore SHOULD put pool quantities back.
async function replaceSheetResources(client: pg.PoolClient, characterId: string, resources: CharacterResource[]): Promise<void> {
  await replaceResources(client, characterId, resources, true);
}

async function replaceResources(client: pg.PoolClient, characterId: string, resources: CharacterResource[], keepPools = false): Promise<void> {
  await client.query(`DELETE FROM character_resources WHERE character_id = $1${keepPools ? " AND resource_key NOT LIKE 'pool:%'" : ''}`, [characterId]);
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

// Upserts one posted inventory row (insert, or update when the id already belongs to this
// character). Shared by the full replace below and by the changes-only Save.
async function upsertInventoryRow(client: pg.PoolClient, characterId: string, row: InventoryItem, sortOrder: number): Promise<void> {
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
      sortOrder,
      row.sourceContentId || null,
      row.attuned || false
    ]
  );
}

// Full replace: deletes every row whose id wasn't passed. Only for callers that really mean "make
// the inventory exactly this" (restoring a version, or a save from a client that sent no baseline).
// The sheet's normal Save uses saveInventoryChanges instead.
async function replaceInventory(client: pg.PoolClient, characterId: string, inventory: InventoryItem[]): Promise<void> {
  const retainedIds = inventory.filter((row) => row.name.trim() && Number(row.quantity) > 0).map((row) => row.id).filter(Boolean);
  await client.query('DELETE FROM character_inventory_items WHERE character_id = $1 AND NOT (id = ANY($2::uuid[]))', [characterId, retainedIds]);
  for (const [index, row] of inventory.entries()) {
    if (!row.name.trim() || Number(row.quantity) <= 0) continue;
    await upsertInventoryRow(client, characterId, row, index);
  }
}

// The columns a sheet Save can change on an existing row, each with the value it would write.
// Both the posted row and the baseline row go through the same getters, so the comparison is on
// what would actually be stored (trimmed names, defaulted categories, and so on).
const INVENTORY_SAVE_FIELDS: Array<[column: string, read: (row: InventoryItem) => string | number | boolean | null]> = [
  ['name', (row) => String(row.name ?? '').trim()],
  ['category', (row) => row.category || 'gear'],
  ['location', (row) => row.location || (row.equipped ? 'equipped' : 'backpack')],
  ['quantity', (row) => Math.max(0, Number(row.quantity) || 0)],
  ['equipped', (row) => row.location === 'equipped' || !!row.equipped],
  ['is_equipment', (row) => !!row.isEquipment],
  ['ac_bonus', (row) => Number(row.acBonus) || 0],
  ['to_hit_bonus', (row) => Number(row.toHitBonus) || 0],
  ['damage_bonus', (row) => Number(row.damageBonus) || 0],
  ['attack_ability', (row) => (abilityKeys.includes(row.attackAbility) ? row.attackAbility : 'str')],
  ['proficient', (row) => row.proficient ?? true],
  ['damage_rolls', (row) => row.damageRolls || ''],
  ['effects', (row) => row.effects || ''],
  ['notes', (row) => row.notes || ''],
  ['source_content_id', (row) => row.sourceContentId || null],
  ['attuned', (row) => !!row.attuned]
];

/**
 * What the sheet showed for HP, temp HP and coin when it loaded (hidden field resourceBaseline, posted with Save).
 * A posted value equal to its baseline was not edited by the user. Null when missing or malformed.
 */
export type ResourceBaseline = { hp?: number; tempHp?: number; coins: Record<string, string> };
const COIN_FIELDS = ['currencyCp', 'currencySp', 'currencyEp', 'currencyGp', 'currencyPp'];

function parseResourceBaseline(form: FormData): ResourceBaseline | null {
  const raw = form.get('resourceBaseline');
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const coins: Record<string, string> = {};
    for (const field of COIN_FIELDS) if (parsed[field] !== undefined) coins[field] = String(parsed[field]).trim();
    return {
      hp: Number.isFinite(Number(parsed.hp)) && parsed.hp !== undefined ? Number(parsed.hp) : undefined,
      tempHp: Number.isFinite(Number(parsed.tempHp)) && parsed.tempHp !== undefined ? Number(parsed.tempHp) : undefined,
      coins
    };
  } catch {
    return null;
  }
}

/**
 * Mutates the parsed resources: an HP / temp HP the user did not edit (posted equals baseline) takes the
 * database's current value. A missing database row keeps the posted value (nothing to preserve).
 */
export function keepUneditedResources(
  resources: CharacterResource[], baseline: ResourceBaseline, db: { hp: number | null; tempHp: number | null }
): void {
  const hp = resources.find((r) => r.key === 'hp');
  if (hp && baseline.hp !== undefined && hp.currentValue === baseline.hp && db.hp !== null) hp.currentValue = db.hp;
  const temp = resources.find((r) => r.key === 'temp_hp');
  if (temp && baseline.tempHp !== undefined && temp.currentValue === baseline.tempHp && db.tempHp !== null) {
    temp.currentValue = db.tempHp;
    temp.maxValue = db.tempHp; // temp HP has no cap of its own (parseResources mirrors current into max)
  }
}

/** Drops each coin field the user did not edit from the metadata patch, so the stored (possibly newer) value stays. */
export function keepUneditedCoins(patch: Record<string, unknown>, baseline: ResourceBaseline): void {
  for (const field of COIN_FIELDS) {
    if (field in baseline.coins && String(patch[field] ?? '').trim() === baseline.coins[field]) delete patch[field];
  }
}

/**
 * The inventory the sheet had loaded when the user pressed Save (hidden field inventoryBaseline).
 * Null when it is missing or malformed, so the caller can fall back to a full replace.
 */
function parseInventoryBaseline(form: FormData): InventoryItem[] | null {
  const raw = form.get('inventoryBaseline');
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter((row) => row && typeof row.id === 'string')
      .map((row) => ({ ...row, abilityBonuses: row.abilityBonuses ?? {} }) as InventoryItem);
  } catch {
    return null;
  }
}

/**
 * Q6: the sheet Save writes only what the user changed since the sheet loaded.
 *
 * Other things change inventory outside the sheet (a forage haul stacking onto a row, VTT item use,
 * equip and remove actions), so blindly writing every posted row would overwrite them with the
 * sheet's stale copy. Instead, comparing the posted rows with the baseline the sheet loaded:
 *   - a row the user did not touch is left alone, whatever the DB now holds;
 *   - a row the user edited gets only the fields they changed (so their edit wins, and a field they
 *     left alone keeps any newer DB value);
 *   - a row with no baseline match is new and is inserted;
 *   - a baseline row that is no longer posted (removed, or quantity set to 0) is deleted;
 *   - rows the sheet never knew about are never touched.
 */
export async function saveInventoryChanges(
  client: pg.PoolClient, characterId: string, posted: InventoryItem[], baseline: InventoryItem[]
): Promise<void> {
  const baselineById = new Map(baseline.map((row) => [row.id as string, row]));
  const postedIds = new Set(posted.map((row) => row.id).filter(Boolean));

  const removedIds = [...baselineById.keys()].filter((id) => !postedIds.has(id));
  if (removedIds.length) {
    await client.query('DELETE FROM character_inventory_items WHERE character_id = $1 AND id = ANY($2::uuid[])', [characterId, removedIds]);
  }

  const maxSort = await client.query<{ next: number }>(
    'SELECT COALESCE(MAX(sort_order) + 1, 0)::int AS next FROM character_inventory_items WHERE character_id = $1', [characterId]
  );
  let nextSort = maxSort.rows[0].next;

  for (const row of posted) {
    const before = row.id ? baselineById.get(row.id) : undefined;
    if (!before) {
      await upsertInventoryRow(client, characterId, row, nextSort++);
      continue;
    }
    const changed = INVENTORY_SAVE_FIELDS.filter(([, read]) => read(row) !== read(before));
    if (!changed.length) continue;
    const assignments = changed.map(([column], index) => `${column} = $${index + 3}`).join(', ');
    await client.query(
      `UPDATE character_inventory_items SET ${assignments} WHERE id = $1 AND character_id = $2`,
      [row.id, characterId, ...changed.map(([, read]) => read(row))]
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
    AND NOT EXISTS (SELECT 1 FROM content_definitions cd WHERE cd.id=active.container_id AND cd.content_type='condition'
      AND cd.content_key=ANY($2::text[]))`,
    [characterId, uniqueKeys.map((key) => 'condition:' + key)]);
  for (const key of uniqueKeys) {
    const effect=await client.query<{id:string}>(`SELECT id FROM content_definitions WHERE content_type='condition'
      AND content_key='condition:'||$1 AND is_archived=false`,[key]);
    if(effect.rowCount){
      const active=await client.query('SELECT 1 FROM active_character_effects WHERE character_id=$1 AND container_id=$2',[characterId,effect.rows[0].id]);
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
    },
    // Per-class hit dice (one resource per class, indexed hit_dice_0, hit_dice_1, ...)
    ...form.getAll('className').map((_, i) => ({
      key: `hit_dice_${i}`,
      label: 'Hit Dice',
      currentValue: Math.max(0, Number(form.get(`hitDiceCurrent_${i}`)) || 0),
      maxValue: Math.max(0, Number(form.get(`hitDiceMax_${i}`)) || 0)
    }))
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

// Overridable-sheet-stats: the sheet always submits statOverridesJson (see
// CharacterSheetForm.svelte's always-present hidden input), so a missing field, invalid JSON, or
// JSON that doesn't even parse to a plain object (null, a bare string/number, an array) means
// something odd happened to the form, not "clear every override" - returning undefined here
// tells updateCharacter to leave the stored statOverrides key untouched rather than wipe it.
// Notably, readStatOverrides() itself is tolerant and would happily coerce any of those
// non-object shapes to `{}` (empty overrides) - which, unlike here, is exactly right when it's
// reading genuinely-stored metadata (an old/corrupt record should behave as "all auto", not
// throw). Here that same tolerance would silently wipe legitimate overrides, so the "is this
// even a plain object" check has to happen before readStatOverrides() gets a chance to launder
// it into `{}`. A genuine reset (an entry removed by the player) still persists correctly,
// because readStatOverrides() only keeps non-default entries and the caller writes the whole
// object back.
export function parseStatOverridesField(form: FormData): StatOverrides | undefined {
  const raw = form.get('statOverridesJson');
  if (typeof raw !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
  return readStatOverrides({ statOverrides: parsed });
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

export async function spendHitDice(
  userId: string,
  characterId: string,
  classIndex: number,
  spent: number,
  defaultMax: number,
  hpGained: number
): Promise<void> {
  await withTransaction(async (client) => {
    await assertCanEditCharacter(client, userId, characterId);

    // Decrement hit dice pool for this class. `defaultMax` only seeds max_value on first
    // INSERT (a pool that doesn't exist yet) - the ON CONFLICT branch deliberately does NOT
    // touch max_value any more, since the sheet's hit dice max is now player-editable
    // (overridable-sheet-stats) and a "Use" click must never silently reset a customised max
    // back to the class level.
    await client.query(`
      INSERT INTO character_resources (character_id, resource_key, label, current_value, max_value, sort_order)
      VALUES ($1, $2, 'Hit Dice', GREATEST(0, $3::int - $4::int), $3::int, ${99 + classIndex})
      ON CONFLICT (character_id, resource_key) DO UPDATE
        SET current_value = GREATEST(0, LEAST(character_resources.max_value, character_resources.current_value - $4))
    `, [characterId, `hit_dice_${classIndex}`, Math.max(1, defaultMax), Math.max(0, spent)]);

    // Recover HP up to max
    if (hpGained > 0) {
      await client.query(`
        UPDATE character_resources
        SET current_value = LEAST(max_value, current_value + $1)
        WHERE character_id = $2 AND resource_key = 'hp'
      `, [hpGained, characterId]);
    }
  });
}
