import crypto from 'node:crypto';
import { query, withTransaction } from '$lib/server/db';
import { invalidateReferenceData } from '$lib/server/cache/referenceData';
import { CampaignError } from '$lib/server/campaignError';
import { getCharacterAccess, isUuid, type Queryable } from '$lib/server/services/access';
import {
  assertOwnedLibraryEntry, assertReferenceAllowed, countHolders, loadLibraryActor, type Holders, type LibraryActor
} from '$lib/server/services/library';
import {
  addContentResourceAction, addSpellAccess, attachActionToContent, attachEffectToAdminContent, attachModifierToContent,
  detachActionFromContent, detachContentModifier, detachEffectFromAdminContent, loadContentAdmin, parseSpellScaling,
  readAdminCost, removeContentResourceAction, removeSpellAccess
} from '$lib/server/services/content-admin';
import { addContentResourceDefinition, grantContentFromContent } from '$lib/server/services/catalogue';
import { splitLibraryFields } from '$lib/library/rules';
import type { ContentType } from '$lib/types/content';

// The authoring side of the personal homebrew library (plans/dndchar/homebrew-library, unit C): the /library page.
//
// The rule from modifier-primacy: authoring MECHANICS is for DM/admin only (LibraryActor.canAuthorMechanics);
// anyone may write DESCRIPTIVE, grant-free entries. So every write here
//   1. checks the entry is the acting user's own personal entry (admins are not an exception: they use /admin),
//   2. checks the mechanics tier for anything that adds a modifier, cost, charge, grant, action or effect,
//   3. then hands over to the existing admin service, which also checks references (assertReferenceAllowed).
// Taking things OFF an entry (detach, remove) only needs ownership: it can never add mechanics.
//
// Lives in its own file rather than library.ts because content-admin.ts already imports library.ts.

/** Types the /library page authors. Decks and conditions come later (units E and F). */
export const AUTHORED_TYPES: ContentType[] = ['item', 'spell', 'feat', 'class_feature'];
/** The tabs on the page. "feat" covers feats and class features. */
export type LibraryTab = 'item' | 'spell' | 'feat';
const TAB_TYPES: Record<LibraryTab, ContentType[]> = { item: ['item'], spell: ['spell'], feat: ['feat', 'class_feature'] };

const MAX_NAME = 200;
const MAX_DESCRIPTION = 20000;

export function parseLibraryTab(value: string | null | undefined): LibraryTab {
  return value === 'spell' || value === 'feat' ? value : 'item';
}

/** The tab an entry type belongs on. */
export function tabForType(type: ContentType): LibraryTab {
  return type === 'spell' ? 'spell' : type === 'feat' || type === 'class_feature' ? 'feat' : 'item';
}

// ---------------------------------------------------------------- load

export type LibraryPageData = Awaited<ReturnType<typeof loadContentAdmin>> & {
  tab: LibraryTab;
  canAuthorMechanics: boolean;
  isAdmin: boolean;
  /** Who depends on the selected entry (the "Held by N characters" note). */
  holders: Holders | null;
  /** The hidden-from-players flag of every listed entry, by id. */
  hidden: Record<string, boolean>;
  /** The character the user came from (the sheet's Create Homebrew link), if they may edit it. */
  from: { id: string; name: string } | null;
};

/** Everything the /library page shows: the user's own entries on one tab, plus the editor data for the selected one. */
export async function loadLibraryPage(userId: string, tab: LibraryTab, selectedId: string, fromCharacterId: string): Promise<LibraryPageData> {
  const actor = await loadLibraryActor({ query }, userId);
  const data = await loadContentAdmin(TAB_TYPES[tab], selectedId, {
    ownerUserId: userId,
    // Nothing selected (an empty library): candidates are what a personal entry of this user may reference.
    source: { scope: 'personal', ownerUserId: userId, campaignId: null }
  });
  const hiddenRows = await query<{ id: string; hidden_from_players: boolean }>(
    `SELECT id, hidden_from_players FROM content_definitions WHERE scope = 'personal' AND owner_user_id = $1 AND content_type = ANY($2::text[])`,
    [userId, TAB_TYPES[tab]]);
  const holders = data.selectedContentId ? await countHolders({ query }, data.selectedContentId) : null;

  // The sheet link only gives a "Back to <character>" button, so a bad or foreign id is simply ignored.
  let from: LibraryPageData['from'] = null;
  if (isUuid(fromCharacterId)) {
    const access = await getCharacterAccess({ query }, userId, fromCharacterId);
    if (access?.canEdit) {
      const row = (await query<{ name: string }>('SELECT name FROM characters WHERE id = $1', [fromCharacterId])).rows[0];
      if (row) from = { id: fromCharacterId, name: row.name };
    }
  }
  return {
    ...data, tab, canAuthorMechanics: actor.canAuthorMechanics, isAdmin: actor.isAdmin, holders,
    hidden: Object.fromEntries(hiddenRows.rows.map((row) => [row.id, row.hidden_from_players])), from
  };
}

// ---------------------------------------------------------------- create and update

// A posted form as plain data, for splitLibraryFields. Checkboxes post nothing when unticked, so they are filled in
// as real booleans here; the multi-select posts several values.
const CHECKBOXES = ['hiddenFromPlayers', 'requiresAttunement', 'ritual', 'concentration'];
function formToRecord(form: FormData): Record<string, unknown> {
  const record: Record<string, unknown> = {};
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key).map(String);
    record[key] = key === 'classes' ? values : values[0];
  }
  for (const key of CHECKBOXES) record[key] = form.get(key) === 'on';
  return record;
}

const ITEM_MECHANICS_COLUMNS: Record<string, string> = {
  acBonus: 'ac_bonus', toHitBonus: 'to_hit_bonus', damageBonus: 'damage_bonus', attackAbility: 'attack_ability', damageRolls: 'damage_rolls'
};
const SPELL_MECHANICS_COLUMNS: Record<string, string> = {
  resolutionType: 'resolution_type', damageType: 'damage_type', baseDice: 'base_dice', saveAbility: 'save_ability', saveEffect: 'save_effect'
};
const ABILITIES = ['str', 'dex', 'con', 'int', 'wis', 'cha'];

/**
 * Writes the posted fields onto an entry. The descriptive part is always written; the mechanics part (bonuses,
 * damage, scaling, cost) only when the actor has mechanics rights. For a descriptive-only author a crafted post
 * carrying `acBonus` or `costJson` is simply dropped by splitLibraryFields + this check, so those columns keep
 * whatever they had (0 and NULL for anything they made).
 */
async function applyFields(client: Queryable, actor: LibraryActor, id: string, type: ContentType, form: FormData): Promise<void> {
  const { descriptive, mechanics } = splitLibraryFields(type, formToRecord(form));
  const name = String(descriptive.name ?? '').trim();
  if (!name) throw new Error('Name is required.');
  if (name.length > MAX_NAME) throw new Error(`Names can be at most ${MAX_NAME} characters.`);
  const description = String(descriptive.description ?? '');
  if (description.length > MAX_DESCRIPTION) throw new Error('That description is too long.');
  await client.query('UPDATE content_definitions SET name=$2, description=$3, hidden_from_players=$4, updated_at=now() WHERE id=$1',
    [id, name, description, descriptive.hiddenFromPlayers === true]);

  if (type === 'item') {
    await client.query('UPDATE item_definitions SET category=$2, equipment_type=$3, requires_attunement=$4 WHERE content_id=$1',
      [id, String(descriptive.category || 'gear'), String(descriptive.equipmentType || 'item'), descriptive.requiresAttunement === true]);
  }
  if (type === 'spell') {
    const classes = Array.isArray(descriptive.classes) ? descriptive.classes.map(String) : [];
    await client.query(`UPDATE spell_definitions SET spell_level=$2, school=$3, casting_time=$4, spell_range=$5, components=$6, duration=$7,
        ritual=$8, concentration=$9, classes=$10 WHERE content_id=$1`,
      [id, Math.min(9, Math.max(0, Number(descriptive.spellLevel) || 0)), String(descriptive.school ?? ''), String(descriptive.castingTime ?? ''),
        String(descriptive.range ?? ''), String(descriptive.components ?? ''), String(descriptive.duration ?? ''),
        descriptive.ritual === true, descriptive.concentration === true, classes]);
  }

  if (!actor.canAuthorMechanics) return;
  // Mechanics: only fields that were actually posted are written, so a form without the Cost block leaves the cost alone.
  const setColumns = async (table: 'item_definitions' | 'spell_definitions', columns: Record<string, string>) => {
    for (const [field, column] of Object.entries(columns)) {
      if (!(field in mechanics)) continue;
      let value: string | number = String(mechanics[field] ?? '');
      if (field === 'attackAbility' || field === 'saveAbility') value = ABILITIES.includes(value) ? value : field === 'attackAbility' ? 'str' : 'dex';
      if (['acBonus', 'toHitBonus', 'damageBonus'].includes(field)) value = Math.trunc(Number(value)) || 0;
      if (field === 'resolutionType' && !['attack', 'save', 'auto'].includes(String(value))) value = 'attack';
      if (field === 'saveEffect' && !['half', 'negate'].includes(String(value))) value = 'half';
      // table and column names come from the fixed maps above, never from the post.
      await client.query(`UPDATE ${table} SET ${column}=$2 WHERE content_id=$1`, [id, value]);
    }
  };
  if (type === 'item') await setColumns('item_definitions', ITEM_MECHANICS_COLUMNS);
  if (type === 'spell') {
    await setColumns('spell_definitions', SPELL_MECHANICS_COLUMNS);
    if ('scalingKind' in mechanics) await client.query('UPDATE spell_definitions SET scaling_json=$2::jsonb WHERE content_id=$1', [id, JSON.stringify(parseSpellScaling(form))]);
  }
  if ('costJson' in mechanics) {
    // '' means "use the default" (NULL); undefined means the posted cost already equals the stored one.
    const cost = await readAdminCost(client as any, id, type, String(mechanics.costJson ?? ''));
    if (cost !== undefined) await client.query('UPDATE content_definitions SET cost_json=$2::jsonb WHERE id=$1', [id, cost === null ? null : JSON.stringify(cost)]);
  }
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'entry';
}

/** Makes a personal entry owned by the user (scope personal, key library:<userId>:<type>:<slug>:<hex>). Returns its id. */
export async function createLibraryEntry(userId: string, form: FormData): Promise<string> {
  const actor = await loadLibraryActor({ query }, userId);
  const type = String(form.get('contentType') || '') as ContentType;
  if (!AUTHORED_TYPES.includes(type)) throw new Error('Choose an item, spell, feat or class feature.');
  const name = String(form.get('name') || '').trim();
  if (!name) throw new Error('Name is required.');
  const key = `library:${userId}:${type}:${slug(name)}:${crypto.randomBytes(4).toString('hex')}`;
  const id = await withTransaction(async (client) => {
    const created = await client.query<{ id: string }>(
      `INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, scope, metadata_json)
       VALUES ($1, $2, $3, '', 'homebrew', $4, 'personal', '{}') RETURNING id`, [key, type, name.slice(0, MAX_NAME), userId]);
    const newId = created.rows[0].id;
    if (type === 'spell') await client.query('INSERT INTO spell_definitions (content_id, spell_level) VALUES ($1, 0)', [newId]);
    if (type === 'item') await client.query('INSERT INTO item_definitions (content_id) VALUES ($1)', [newId]);
    await applyFields(client, actor, newId, type, form);
    return newId;
  });
  invalidateReferenceData('library:create');
  return id;
}

/** Edits the user's own entry. Descriptive fields always; mechanics fields only for DM-tier users. */
export async function updateLibraryEntry(userId: string, form: FormData): Promise<string> {
  const actor = await loadLibraryActor({ query }, userId);
  const id = String(form.get('contentId') || '');
  await withTransaction(async (client) => {
    const facts = await assertOwnedLibraryEntry(client, actor, id);
    if (!AUTHORED_TYPES.includes(facts.type)) throw new CampaignError('Library entry not found.');
    await applyFields(client, actor, id, facts.type, form);
  });
  invalidateReferenceData('library:update');
  return id;
}

/** Archive or restore. An archived entry is not offered for new use but still works wherever it is already held. */
export async function toggleLibraryArchive(userId: string, form: FormData): Promise<string> {
  const id = String(form.get('contentId') || '');
  await assertOwnedLibraryEntry({ query }, { userId }, id);
  await query('UPDATE content_definitions SET is_archived = NOT is_archived, updated_at = now() WHERE id = $1', [id]);
  invalidateReferenceData('library:archive');
  return id;
}

// ---------------------------------------------------------------- mechanics wrappers

/** Owner of the entry and a DM-tier user: the check for anything that ADDS mechanics. Returns the entry's type. */
async function ownedWithMechanics(userId: string, contentId: string): Promise<ContentType> {
  const actor = await loadLibraryActor({ query }, userId);
  const facts = await assertOwnedLibraryEntry({ query }, actor, contentId);
  if (!actor.canAuthorMechanics) throw new CampaignError('Adding rules to an entry is for DMs and admins. Ask your DM to add them.');
  return facts.type;
}

/** The owner of the entry: the check for taking mechanics OFF an entry. */
async function owned(userId: string, contentId: string): Promise<ContentType> {
  return (await assertOwnedLibraryEntry({ query }, { userId }, contentId)).type;
}

const field = (form: FormData, name: string) => String(form.get(name) || '');

async function typeOf(db: Queryable, id: string): Promise<string | null> {
  if (!isUuid(id)) return null;
  return (await db.query('SELECT content_type FROM content_definitions WHERE id = $1', [id])).rows[0]?.content_type ?? null;
}

export async function libraryAttachModifier(userId: string, form: FormData) {
  await ownedWithMechanics(userId, field(form, 'contentId'));
  return attachModifierToContent(form);
}
export async function libraryDetachModifier(userId: string, form: FormData) {
  await owned(userId, field(form, 'contentId'));
  return detachContentModifier(form);
}

export async function libraryAttachEffect(userId: string, form: FormData) {
  await ownedWithMechanics(userId, field(form, 'contentId'));
  return attachEffectToAdminContent(form); // checks the effect may be referenced
}
export async function libraryDetachEffect(userId: string, form: FormData) {
  await owned(userId, field(form, 'contentId'));
  return detachEffectFromAdminContent(form);
}

export async function libraryAddResource(userId: string, form: FormData) {
  const contentId = field(form, 'contentId');
  const type = await ownedWithMechanics(userId, contentId);
  if (!['item', 'feat', 'class_feature'].includes(type)) throw new Error('Only items, feats and class features have charges.');
  // The editor offers a fixed list, so anything else is a crafted post.
  if (!/^(\d{1,2}|proficiency_bonus|ability_modifier|level)$/.test(field(form, 'maxValueExpression') || '1')) throw new Error('Choose a maximum from the list.');
  return addContentResourceDefinition(form);
}

export async function libraryGrantContent(userId: string, form: FormData) {
  const sourceId = field(form, 'sourceContentId');
  const type = await ownedWithMechanics(userId, sourceId);
  if (type !== 'item') throw new Error('Only items grant feats and features.');
  const grantedType = await typeOf({ query }, field(form, 'grantedContentId'));
  if (grantedType !== 'feat' && grantedType !== 'class_feature') throw new Error('Choose a feat or class feature.');
  return grantContentFromContent(form); // checks the granted entry may be referenced
}

export async function libraryAttachAction(userId: string, form: FormData) {
  await ownedWithMechanics(userId, field(form, 'contentId'));
  return attachActionToContent(form); // checks the action may be referenced
}
export async function libraryDetachAction(userId: string, form: FormData) {
  await owned(userId, field(form, 'contentId'));
  return detachActionFromContent(form);
}

export async function libraryAddAction(userId: string, form: FormData) {
  const contentId = field(form, 'contentId');
  await ownedWithMechanics(userId, contentId);
  // An apply/remove-effect step points at a condition: it must be a real one this entry may reference.
  const effectId = field(form, 'effectId');
  if (effectId) {
    if ((await typeOf({ query }, effectId)) !== 'condition') throw new Error('Choose a condition.');
    await assertReferenceAllowed({ query }, contentId, effectId);
  }
  return addContentResourceAction(form);
}
export async function libraryRemoveActionStep(userId: string, form: FormData) {
  await owned(userId, field(form, 'contentId'));
  return removeContentResourceAction(form); // only removes a step of an action linked to this entry
}

export async function libraryAddSpellAccess(userId: string, form: FormData) {
  const contentId = field(form, 'contentId');
  const type = await ownedWithMechanics(userId, contentId);
  if (type !== 'item') throw new Error('Only items grant spells.');
  if ((await typeOf({ query }, field(form, 'spellContentId'))) !== 'spell') throw new Error('Choose a spell.');
  // A charge resource must be one of THIS entry's own counters, never another entry's.
  const resourceId = field(form, 'resourceDefinitionId');
  if (resourceId) {
    const ok = isUuid(resourceId) && (await query('SELECT 1 FROM content_resource_definitions WHERE id = $1 AND content_id = $2', [resourceId, contentId])).rows.length;
    if (!ok) throw new Error('Choose one of this item\'s own counters.');
  }
  return addSpellAccess(form); // checks the spell may be referenced
}
export async function libraryRemoveSpellAccess(userId: string, form: FormData) {
  await owned(userId, field(form, 'contentId'));
  return removeSpellAccess(form);
}
