import { query, withTransaction } from '$lib/server/db';
import { invalidateReferenceData } from '$lib/server/cache/referenceData';
import { CampaignError } from '$lib/server/campaignError';
import { getCampaignAccess, isUuid } from '$lib/server/services/access';
import { assertCampaignEntry, assertReferenceAllowed, countHolders, type Holders } from '$lib/server/services/library';
import {
  addContentResourceAction, addSpellAccess, attachActionToContent, attachEffectToAdminContent, attachModifierToContent,
  detachActionFromContent, detachContentModifier, detachEffectFromAdminContent, loadContentAdmin, removeContentResourceAction, removeSpellAccess
} from '$lib/server/services/content-admin';
import { addContentResourceDefinition, grantContentFromContent } from '$lib/server/services/catalogue';
import { applyFields } from '$lib/server/services/library-authoring';
import { attachEffectModifier, detachEffectModifier, loadModifiers, saveEffect } from '$lib/server/services/rules-admin';
import type { ContentType } from '$lib/types/content';

// The campaign copies page (plans/dndchar/homebrew-library, unit G): /campaigns/[id]/homebrew. A campaign copy is made
// only by a fork (a member leaving, or the DM's Keep a campaign copy button), so there is deliberately NO create here.
// What a DM / co-DM / admin CAN do is edit a copy (full mechanics, as campaign content), archive or restore it, and
// attach things to it under the campaign reference rule (global, this campaign's entries, and conditions of libraries
// switched on here). Nothing is ever deleted. Decks are campaign content too but have their own page.
//
// Every write goes through assertCampaignEntry (canManage on a live campaign, and the entry is a campaign entry of
// THIS campaign), so a forged id from another campaign or a personal entry is refused as "not found".

export type HomebrewTab = 'item' | 'spell' | 'feat' | 'condition';
const TAB_TYPES: Record<HomebrewTab, ContentType[]> = { item: ['item'], spell: ['spell'], feat: ['feat', 'class_feature'], condition: ['condition'] };

export function parseHomebrewTab(value: string | null | undefined): HomebrewTab {
  return value === 'spell' || value === 'feat' || value === 'condition' ? value : 'item';
}
export function homebrewTabForType(type: ContentType): HomebrewTab {
  return type === 'spell' ? 'spell' : type === 'feat' || type === 'class_feature' ? 'feat' : type === 'condition' ? 'condition' : 'item';
}

export type ForkInfo = { fromOwnerName: string | null; at: string | null; reason: string | null };

/** The page's data, or why not: 'missing' = 404 (a stranger or a bad id), 'forbidden' = 403 (a member who is not a DM). */
export type HomebrewLoad = { status: 'ok'; data: any } | { status: 'missing' } | { status: 'forbidden' };

async function forkInfoFor(campaignId: string, types: ContentType[]): Promise<Record<string, ForkInfo>> {
  const rows = await query<any>(
    `SELECT id, metadata_json->'fork'->>'fromOwnerName' AS owner_name, metadata_json->'fork'->>'at' AS at, metadata_json->'fork'->>'reason' AS reason
     FROM content_definitions WHERE scope = 'campaign' AND campaign_id = $1 AND content_type = ANY($2::text[])`, [campaignId, types]);
  return Object.fromEntries(rows.rows.map((row) => [row.id, { fromOwnerName: row.owner_name, at: row.at, reason: row.reason }]));
}

/** Everything the page shows for one tab. canManage is required to see anything (the copies carry rules). */
export async function loadCampaignHomebrew(userId: string, campaignId: string, tab: HomebrewTab, selectedId: string): Promise<HomebrewLoad> {
  const access = isUuid(campaignId) ? await getCampaignAccess({ query }, userId, campaignId) : null;
  if (!access?.canView) return { status: 'missing' };
  if (!access.canManage) return { status: 'forbidden' };
  const campaign = (await query<{ name: string }>('SELECT name FROM campaigns WHERE id = $1', [campaignId])).rows[0];
  if (!campaign) return { status: 'missing' };
  const base = { campaignId, campaignName: campaign.name, archived: access.archived, tab };
  const forks = await forkInfoFor(campaignId, TAB_TYPES[tab]);

  if (tab === 'condition') {
    return { status: 'ok', data: { ...base, ...(await loadCampaignConditions(campaignId, selectedId)), forks } };
  }
  const data = await loadContentAdmin(TAB_TYPES[tab], selectedId, { campaignId, source: { scope: 'campaign', ownerUserId: null, campaignId } });
  const hiddenRows = await query<{ id: string; hidden_from_players: boolean }>(
    `SELECT id, hidden_from_players FROM content_definitions WHERE scope = 'campaign' AND campaign_id = $1 AND content_type = ANY($2::text[])`,
    [campaignId, TAB_TYPES[tab]]);
  const holders: Holders | null = data.selectedContentId ? await countHolders({ query }, data.selectedContentId) : null;
  return {
    status: 'ok',
    data: { ...base, ...data, forks, holders, hidden: Object.fromEntries(hiddenRows.rows.map((row) => [row.id, row.hidden_from_players])) }
  };
}

// ---------------------------------------------------------------- items, spells, feats and features

const field = (form: FormData, name: string) => String(form.get(name) || '');

/** The copy this write is about: a campaign entry of this campaign the actor may manage. Returns its type. */
async function copyOf(userId: string, campaignId: string, contentId: string): Promise<ContentType> {
  return (await assertCampaignEntry({ query }, userId, campaignId, contentId)).type;
}

/** Edits a copy. A DM has full mechanics on campaign content, so the whole form is written. Returns the id. */
export async function updateCampaignEntry(userId: string, campaignId: string, form: FormData): Promise<string> {
  const id = field(form, 'contentId');
  await withTransaction(async (client) => {
    const facts = await assertCampaignEntry(client, userId, campaignId, id);
    if (!['item', 'spell', 'feat', 'class_feature'].includes(facts.type)) throw new CampaignError('Campaign entry not found.');
    // The same field writer as /library, with mechanics rights (the form is the shared editor's).
    await applyFields(client, { userId, isAdmin: false, dmCampaignCount: 1, canAuthorMechanics: true }, id, facts.type, form);
  });
  invalidateReferenceData('library:homebrew:update');
  return id;
}

/** Archive or restore a copy (any type). An archived copy is not offered for new use but still works where it is held. */
export async function toggleCampaignEntryArchive(userId: string, campaignId: string, form: FormData): Promise<string> {
  const id = field(form, 'contentId') || field(form, 'effectId');
  await copyOf(userId, campaignId, id);
  await query('UPDATE content_definitions SET is_archived = NOT is_archived, updated_at = now() WHERE id = $1', [id]);
  invalidateReferenceData('library:homebrew:archive');
  return id;
}

export async function campaignAttachModifier(userId: string, campaignId: string, form: FormData) {
  await copyOf(userId, campaignId, field(form, 'contentId'));
  return attachModifierToContent(form);
}
export async function campaignDetachModifier(userId: string, campaignId: string, form: FormData) {
  await copyOf(userId, campaignId, field(form, 'contentId'));
  return detachContentModifier(form);
}
export async function campaignAttachEffect(userId: string, campaignId: string, form: FormData) {
  await copyOf(userId, campaignId, field(form, 'contentId'));
  return attachEffectToAdminContent(form); // checks the condition may be referenced from a campaign entry
}
export async function campaignDetachEffect(userId: string, campaignId: string, form: FormData) {
  await copyOf(userId, campaignId, field(form, 'contentId'));
  return detachEffectFromAdminContent(form);
}
export async function campaignAddResource(userId: string, campaignId: string, form: FormData) {
  const type = await copyOf(userId, campaignId, field(form, 'contentId'));
  if (!['item', 'feat', 'class_feature'].includes(type)) throw new Error('Only items, feats and class features have charges.');
  return addContentResourceDefinition(form);
}
export async function campaignGrantContent(userId: string, campaignId: string, form: FormData) {
  const type = await copyOf(userId, campaignId, field(form, 'sourceContentId'));
  if (type !== 'item') throw new Error('Only items grant feats and features.');
  return grantContentFromContent(form); // checks the granted entry may be referenced
}
export async function campaignAttachAction(userId: string, campaignId: string, form: FormData) {
  await copyOf(userId, campaignId, field(form, 'contentId'));
  return attachActionToContent(form); // checks the action may be referenced
}
export async function campaignDetachAction(userId: string, campaignId: string, form: FormData) {
  await copyOf(userId, campaignId, field(form, 'contentId'));
  return detachActionFromContent(form);
}
export async function campaignAddAction(userId: string, campaignId: string, form: FormData) {
  const contentId = field(form, 'contentId');
  await copyOf(userId, campaignId, contentId);
  const effectId = field(form, 'effectId');
  if (effectId) {
    const row = isUuid(effectId) ? (await query('SELECT content_type FROM content_definitions WHERE id = $1', [effectId])).rows[0] : null;
    if (row?.content_type !== 'condition') throw new Error('Choose a condition.');
    await assertReferenceAllowed({ query }, contentId, effectId);
  }
  return addContentResourceAction(form);
}
export async function campaignRemoveActionStep(userId: string, campaignId: string, form: FormData) {
  await copyOf(userId, campaignId, field(form, 'contentId'));
  return removeContentResourceAction(form); // only removes a step of an action linked to this entry
}
export async function campaignAddSpellAccess(userId: string, campaignId: string, form: FormData) {
  const contentId = field(form, 'contentId');
  const type = await copyOf(userId, campaignId, contentId);
  if (type !== 'item') throw new Error('Only items grant spells.');
  const resourceId = field(form, 'resourceDefinitionId');
  if (resourceId) {
    const ok = isUuid(resourceId) && (await query('SELECT 1 FROM content_resource_definitions WHERE id = $1 AND content_id = $2', [resourceId, contentId])).rows.length;
    if (!ok) throw new Error("Choose one of this item's own counters.");
  }
  return addSpellAccess(form); // checks the spell may be referenced
}
export async function campaignRemoveSpellAccess(userId: string, campaignId: string, form: FormData) {
  await copyOf(userId, campaignId, field(form, 'contentId'));
  return removeSpellAccess(form);
}

// ---------------------------------------------------------------- conditions

export type CampaignConditionRow = {
  id: string; name: string; description: string; durationType: string; durationRounds: number | null; requiresConcentration: boolean;
  stackBehavior: string; expiryBoundary: string; isCondition: boolean; isArchived: boolean; modifierCount: number;
};

// The same shape as /library/conditions (services/library-conditions.ts), for the campaign's own copies. The editor
// component is shared, so the field names match.
async function loadCampaignConditions(campaignId: string, selectedId: string) {
  const rows = await query<any>(
    `SELECT c.id, c.name, COALESCE(c.description,'') AS description,
       COALESCE(c.metadata_json->>'legacyDurationType',
         CASE c.duration_type WHEN 'rounds' THEN 'timed' WHEN 'concentration' THEN 'concentration' ELSE 'variable' END) AS duration_type,
       c.duration_rounds, c.requires_concentration, c.stack_behavior, COALESCE(c.expiry_boundary,'round_end') AS expiry_boundary,
       COALESCE(c.metadata_json->>'isCondition','false') = 'true' AS is_condition, c.is_archived,
       (SELECT count(*)::int FROM content_modifier_links WHERE content_id = c.id) AS modifier_count
     FROM content_definitions c
     WHERE c.content_type = 'condition' AND c.scope = 'campaign' AND c.campaign_id = $1
     ORDER BY c.is_archived, c.name`, [campaignId]);
  const conditions: CampaignConditionRow[] = rows.rows.map((row) => ({
    id: row.id, name: row.name, description: row.description, durationType: row.duration_type, durationRounds: row.duration_rounds,
    requiresConcentration: row.requires_concentration, stackBehavior: row.stack_behavior, expiryBoundary: row.expiry_boundary,
    isCondition: row.is_condition, isArchived: row.is_archived, modifierCount: row.modifier_count
  }));
  const selected = conditions.find((entry) => entry.id === selectedId) ?? conditions[0] ?? null;
  let links: any[] = [];
  let holders: Holders | null = null;
  if (selected) {
    const result = await query<any>(
      `SELECT link.id, hook.label AS hook_label, modifier.modifier_type,
         COALESCE(link.value_override_expression, modifier.default_value_expression, '') AS value_expression,
         COALESCE(link.condition_expression, '') AS condition_expression, link.priority
       FROM content_modifier_links link JOIN modifier_definitions modifier ON modifier.id = link.modifier_id
       JOIN modifier_targets hook ON hook.target_key = modifier.target WHERE link.content_id = $1 ORDER BY link.priority, hook.label`, [selected.id]);
    links = result.rows.map((row) => ({ id: row.id, hookLabel: row.hook_label, operation: row.modifier_type, valueExpression: row.value_expression, condition: row.condition_expression, priority: row.priority }));
    holders = await countHolders({ query }, selected.id);
  }
  const modifiers = selected ? (await loadModifiers()).modifiers.filter((m: any) => !m.isArchived) : [];
  return { conditions, selected, links, holders, modifiers, canAuthorMechanics: true };
}

async function copyCondition(userId: string, campaignId: string, id: string): Promise<void> {
  const type = await copyOf(userId, campaignId, id);
  if (type !== 'condition') throw new CampaignError('Campaign entry not found.');
}

/** Edits a condition copy (name, duration, stacking, expiry...). The shared effect writer, after the campaign check. */
export async function saveCampaignCondition(userId: string, campaignId: string, form: FormData): Promise<string> {
  const id = field(form, 'effectId');
  await copyCondition(userId, campaignId, id);
  await saveEffect(userId, form); // writes by id; the copy check was just above
  invalidateReferenceData('library:homebrew:condition');
  return id;
}
export async function attachCampaignConditionModifier(userId: string, campaignId: string, form: FormData): Promise<string> {
  const id = field(form, 'effectId');
  await copyCondition(userId, campaignId, id);
  if (!isUuid(field(form, 'modifierId'))) throw new CampaignError('Choose a modifier.');
  return attachEffectModifier(form);
}
export async function detachCampaignConditionModifier(userId: string, campaignId: string, form: FormData): Promise<string> {
  const id = field(form, 'effectId');
  await copyCondition(userId, campaignId, id);
  await detachEffectModifier(id, field(form, 'linkId')); // only deletes a link that belongs to this condition
  return id;
}
