import crypto from 'node:crypto';
import { query } from '$lib/server/db';
import { invalidateReferenceData } from '$lib/server/cache/referenceData';
import { CampaignError } from '$lib/server/campaignError';
import { isUuid } from '$lib/server/services/access';
import { assertOwnedLibraryEntry, countHolders, loadLibraryActor, type Holders } from '$lib/server/services/library';
import { attachEffectModifier, detachEffectModifier, loadModifiers, saveEffect } from '$lib/server/services/rules-admin';

// Personal conditions in the homebrew library (plans/dndchar/homebrew-library, unit F). Conditions are DM-tier: they
// carry modifiers, so authoring them is mechanics. The fields and the saving are the same as /admin/rules/effects
// (saveEffect does the writing, after the ownership and tier checks here), but a personal condition:
//   - has scope 'personal' and owner = the author, so it is never in the global list;
//   - has the key condition:library:<userId>:<slug>:<hex>. Keeping the "condition:" prefix means the sheet's
//     snapshots and restore (which store and look up conditions by the key without it) keep working unchanged, and
//     the owner's id in the key means two owners' conditions can never collide;
//   - is OFFERED only where the visible-set rule allows (the author's own decks and sheets, and campaigns whose DM
//     has switched their library on). Anything already applied or named by a deck keeps working by reference.
// VTT token conditions (vttConditions.ts) stay a fixed global set and never see these.

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'condition';

/** The author's own condition, checked for ownership and type. Admin is not an exception (they use /admin/rules/effects). */
async function ownedCondition(userId: string, id: string): Promise<void> {
  const facts = await assertOwnedLibraryEntry({ query }, { userId }, id);
  if (facts.type !== 'condition') throw new CampaignError('Library entry not found.');
}

async function requireDmTier(userId: string): Promise<void> {
  const actor = await loadLibraryActor({ query }, userId);
  if (!actor.canAuthorMechanics) throw new CampaignError('Conditions are for DMs and admins, because they carry rules. Ask your DM to make one.');
}

export type LibraryConditionRow = {
  id: string; name: string; description: string; durationType: string; durationRounds: number | null; requiresConcentration: boolean;
  stackBehavior: string; expiryBoundary: string; isCondition: boolean; isArchived: boolean; modifierCount: number;
};
export type LibraryConditionLink = { id: string; hookLabel: string; operation: string; valueExpression: string; condition: string; priority: number };

export async function loadLibraryConditions(userId: string, selectedId: string) {
  const actor = await loadLibraryActor({ query }, userId);
  const rows = await query<any>(
    `SELECT c.id, c.name, COALESCE(c.description,'') AS description,
       COALESCE(c.metadata_json->>'legacyDurationType',
         CASE c.duration_type WHEN 'rounds' THEN 'timed' WHEN 'concentration' THEN 'concentration' ELSE 'variable' END) AS duration_type,
       c.duration_rounds, c.requires_concentration, c.stack_behavior, COALESCE(c.expiry_boundary,'round_end') AS expiry_boundary,
       COALESCE(c.metadata_json->>'isCondition','false') = 'true' AS is_condition, c.is_archived,
       (SELECT count(*)::int FROM content_modifier_links WHERE content_id = c.id) AS modifier_count
     FROM content_definitions c
     WHERE c.content_type = 'condition' AND c.scope = 'personal' AND c.owner_user_id = $1
     ORDER BY c.is_archived, c.name`, [userId]);
  const conditions: LibraryConditionRow[] = rows.rows.map((row) => ({
    id: row.id, name: row.name, description: row.description, durationType: row.duration_type, durationRounds: row.duration_rounds,
    requiresConcentration: row.requires_concentration, stackBehavior: row.stack_behavior, expiryBoundary: row.expiry_boundary,
    isCondition: row.is_condition, isArchived: row.is_archived, modifierCount: row.modifier_count
  }));
  const selected = conditions.find((entry) => entry.id === selectedId) ?? null;
  let links: LibraryConditionLink[] = [];
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
  // Modifier definitions stay global and admin-authored; a DM only picks from them.
  const modifiers = actor.canAuthorMechanics && selected ? (await loadModifiers()).modifiers.filter((m: any) => !m.isArchived) : [];
  return { conditions, selected, links, holders, modifiers, canAuthorMechanics: actor.canAuthorMechanics };
}

/** Makes a personal condition (DM-tier) and fills it in with the shared effect fields. Returns its id. */
export async function createLibraryCondition(userId: string, form: FormData): Promise<string> {
  await requireDmTier(userId);
  const name = String(form.get('name') || '').trim();
  if (!name) throw new CampaignError('Name is required.');
  if (name.length > 200) throw new CampaignError('Names can be at most 200 characters.');
  const key = `condition:library:${userId}:${slug(name)}:${crypto.randomBytes(4).toString('hex')}`;
  const created = await query<{ id: string }>(
    `INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, scope, activation_type,
       requires_concentration, stack_behavior, metadata_json)
     VALUES ($1, 'condition', $2, '', 'homebrew', $3, 'personal', 'passive', false, 'refresh', '{"isHomebrew": true, "sortOrder": 0}'::jsonb) RETURNING id`,
    [key, name, userId]);
  const id = created.rows[0].id;
  form.set('effectId', id);
  await saveEffect(userId, form);
  invalidateReferenceData('library:condition:create');
  return id;
}

/** Edits the author's own condition. */
export async function saveLibraryCondition(userId: string, form: FormData): Promise<string> {
  await requireDmTier(userId);
  const id = String(form.get('effectId') || '');
  await ownedCondition(userId, id);
  await saveEffect(userId, form); // writes by id; ownership was checked just above
  return id;
}

/** Archive or restore. Archived conditions are not offered or newly named, but stay on whoever has them. Ownership only. */
export async function archiveLibraryCondition(userId: string, id: string): Promise<string> {
  await ownedCondition(userId, id);
  await query('UPDATE content_definitions SET is_archived = NOT is_archived, updated_at = now() WHERE id = $1', [id]);
  invalidateReferenceData('library:condition:archive');
  return id;
}

export async function attachLibraryConditionModifier(userId: string, form: FormData): Promise<string> {
  await requireDmTier(userId);
  const id = String(form.get('effectId') || '');
  await ownedCondition(userId, id);
  if (!isUuid(String(form.get('modifierId') || ''))) throw new CampaignError('Choose a modifier.');
  return attachEffectModifier(form);
}

/** Taking a modifier OFF needs ownership only. */
export async function detachLibraryConditionModifier(userId: string, form: FormData): Promise<string> {
  const id = String(form.get('effectId') || '');
  await ownedCondition(userId, id);
  await detachEffectModifier(id, String(form.get('linkId') || '')); // only deletes a link that belongs to this condition
  return id;
}
