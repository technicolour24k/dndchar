// Homebrew library rules (plans/dndchar/homebrew-library). PURE: no $lib/server imports and no DB, so every rule
// here is unit-tested in rules.test.ts. The server helpers in services/library.ts load the facts and feed them in.
//
// Three scopes (migration 050):
//   global   - everything that exists today (SRD, seeds, admin content).
//   personal - one user's library entry.
//   campaign - owned by a campaign (campaign decks, and copies forked from a leaver's library).
//
// The one rule that matters most: VISIBILITY GATES NEW USE ONLY, NEVER RESOLUTION. Everything here decides what
// may be OFFERED or ADDED. Nothing that is already held, known, applied or enabled is ever filtered by it.

import type { ContentType, LibraryScope } from '$lib/types/content';

export type { LibraryScope };

/** What the rules need to know about one entry. */
export type EntryFacts = {
  scope: LibraryScope;
  ownerUserId: string | null;
  campaignId: string | null;
  hiddenFromPlayers: boolean;
  isArchived: boolean;
  type: ContentType;
};

/**
 * The set of entries one viewer may be offered for NEW use, worked out once by the server.
 *  - campaignId: campaign-scope entries of this campaign are visible (null = none are).
 *  - ownerIds: personal libraries that are visible (a campaign's enabled libraries, or just the viewer's own).
 *  - hiddenOkOwnerIds: of those, the owners whose "hidden from players" entries the viewer may also see
 *    (the owner themselves, the campaign's DMs and admins).
 *  - hiddenOkCampaign: the viewer may see hidden campaign-scope entries (a DM/co-DM of that campaign, or an admin).
 */
export type VisibleScope = {
  campaignId: string | null;
  ownerIds: string[];
  hiddenOkOwnerIds: string[];
  hiddenOkCampaign: boolean;
};

/** A library is off in a campaign until its DM turns it on, so a member with no settings row is off. */
export const MEMBER_LIBRARY_DEFAULT_ENABLED = false;

/** Types anyone may keep in a library (descriptive only unless they are DM-tier). */
export const LIBRARY_TYPES: ContentType[] = ['item', 'spell', 'feat', 'class_feature', 'deck', 'condition'];
/** Types only DM-tier users (site admins, or a DM/co-DM of a live campaign) may author. */
export const DM_ONLY_LIBRARY_TYPES: ContentType[] = ['deck', 'condition'];

/** One campaign_library_settings row, as plain data. */
export type LibrarySetting = { ownerUserId: string; isEnabled: boolean };

/**
 * Whose libraries are switched on in a campaign. Only current members count: a setting row for someone who is not
 * a member (they left, the row stays so a rejoin keeps the DM's choice) switches nothing on.
 */
export function enabledLibraryOwners(memberIds: string[], settings: LibrarySetting[]): string[] {
  const byOwner = new Map(settings.map((row) => [row.ownerUserId, row.isEnabled]));
  return memberIds.filter((id) => byOwner.get(id) ?? MEMBER_LIBRARY_DEFAULT_ENABLED);
}

/** May this entry be OFFERED (picker, add, enable) to someone with this visible scope? Never used to filter held content. */
export function isVisibleForNewUse(entry: EntryFacts, scope: VisibleScope): boolean {
  if (entry.isArchived) return false;
  if (entry.scope === 'global') return true;
  if (entry.scope === 'personal') {
    if (!entry.ownerUserId || !scope.ownerIds.includes(entry.ownerUserId)) return false;
    return !entry.hiddenFromPlayers || scope.hiddenOkOwnerIds.includes(entry.ownerUserId);
  }
  // campaign scope
  if (!entry.campaignId || entry.campaignId !== scope.campaignId) return false;
  return !entry.hiddenFromPlayers || scope.hiddenOkCampaign;
}

/**
 * May an entry (the source) point at another entry (the target), for example a grant, spell access, an action step
 * or a deck condition key? Stops a global entry depending on someone's private one. Archived targets are refused
 * (this is a new reference).
 *  - global   -> global only.
 *  - personal -> global, and the SAME owner's personal entries.
 *  - campaign -> global, the same campaign's entries, and personal CONDITIONS of libraries enabled in that campaign.
 * Modifier definitions are not entries; they stay global and admin-only.
 */
export function canReference(
  source: { scope: LibraryScope; ownerUserId: string | null; campaignId: string | null },
  target: EntryFacts,
  enabledOwnerIds: string[] = []
): boolean {
  if (target.isArchived) return false;
  if (target.scope === 'global') return true;
  if (source.scope === 'personal') {
    return target.scope === 'personal' && source.ownerUserId !== null && target.ownerUserId === source.ownerUserId;
  }
  if (source.scope === 'campaign') {
    if (target.scope === 'campaign') return source.campaignId !== null && target.campaignId === source.campaignId;
    return target.type === 'condition' && target.ownerUserId !== null && enabledOwnerIds.includes(target.ownerUserId);
  }
  return false; // a global source never points at a personal or campaign entry
}

/** Mechanics (modifiers, costs, decks, conditions) are for site admins and DMs of at least one live campaign. */
export function canAuthorMechanics(actor: { isAdmin: boolean; dmCampaignCount: number }): boolean {
  return actor.isAdmin || actor.dmCampaignCount > 0;
}

// ---------------------------------------------------------------- descriptive vs mechanics fields

// Form fields by type. "Descriptive" is flavour a player may write; "mechanics" changes the numbers or what the
// entry does. A descriptive-only author's save never touches a mechanics field, so a crafted post cannot add one.
const DESCRIPTIVE_COMMON = ['name', 'description', 'hiddenFromPlayers'];
const DESCRIPTIVE_BY_TYPE: Partial<Record<ContentType, string[]>> = {
  item: ['category', 'equipmentType', 'requiresAttunement'],
  spell: ['spellLevel', 'school', 'castingTime', 'range', 'components', 'duration', 'ritual', 'concentration', 'classes']
};
const MECHANICS_COMMON = ['costJson'];
const MECHANICS_BY_TYPE: Partial<Record<ContentType, string[]>> = {
  item: ['acBonus', 'toHitBonus', 'damageBonus', 'attackAbility', 'damageRolls'],
  spell: [
    'resolutionType', 'damageType', 'baseDice', 'saveAbility', 'saveEffect',
    'scalingKind', 'scalingExtraDice', 'scalingTiers', 'scalingExtraDicePerSlotLevel'
  ],
  deck: ['rulesText'],
  condition: ['durationType', 'durationRounds', 'expiryBoundary', 'stackBehavior', 'requiresConcentration']
};

/** Splits a posted form into the part anyone may write and the part that needs mechanics rights. Unknown keys are dropped. */
export function splitLibraryFields(
  type: ContentType,
  form: Record<string, unknown>
): { descriptive: Record<string, unknown>; mechanics: Record<string, unknown> } {
  const pick = (keys: string[]) => {
    const out: Record<string, unknown> = {};
    for (const key of keys) if (key in form) out[key] = form[key];
    return out;
  };
  return {
    descriptive: pick([...DESCRIPTIVE_COMMON, ...(DESCRIPTIVE_BY_TYPE[type] ?? [])]),
    mechanics: pick([...MECHANICS_COMMON, ...(MECHANICS_BY_TYPE[type] ?? [])])
  };
}

// ---------------------------------------------------------------- labels

/** "SRD", "Homebrew", "Bob's homebrew", "Campaign" or "Campaign copy (from Bob's library)". Straight apostrophes. */
export function catalogueSourceLabel(entry: {
  sourceKind: 'srd' | 'homebrew';
  scope: LibraryScope;
  ownerName: string | null;
  forkedFromOwnerName: string | null;
}): string {
  if (entry.scope === 'campaign') {
    return entry.forkedFromOwnerName ? `Campaign copy (from ${entry.forkedFromOwnerName}'s library)` : 'Campaign';
  }
  if (entry.scope === 'personal') return `${entry.ownerName ?? 'Someone'}'s homebrew`;
  return entry.sourceKind === 'srd' ? 'SRD' : 'Homebrew';
}

// ---------------------------------------------------------------- fork planner

/** Largest set the fork will copy in one go. Above this something is badly wrong, so it refuses. */
export const FORK_ENTRY_CAP = 500;

export type ForkReason = 'left' | 'removed' | 'manual' | 'repair';

/** One content row the planner may copy (plain data, loaded by the server). */
export type ForkEntry = {
  id: string;
  key: string;
  type: ContentType;
  name: string;
  scope: LibraryScope;
  ownerUserId: string | null;
  isArchived: boolean;
};

export type ForkInput = {
  campaignId: string;
  /** The library owner whose content is being kept. */
  ownerUserId: string;
  reason: ForkReason;
  /** The owner's personal entries that could be involved (anything else is never copied). */
  entries: ForkEntry[];
  /** Entry ids the campaign uses directly (step 2 of the fork). Ids that are not the owner's personal entries are skipped. */
  roots: string[];
  /** References between entries: grants, spell access, action containers, action step effects, deck condition keys. */
  edges: Array<{ from: string; to: string }>;
  /** Copies that already exist in this campaign (forked_from_content_id), so a re-run reuses them. */
  existingCopies: Array<{ originalId: string; copyId: string; copyKey: string }>;
  /** Charge resource definitions of the originals and of any existing copies. Copied resources must keep their original keys, because the remap matches on key. */
  originalResources: Array<{ contentId: string; id: string; key: string }>;
  copyResources: Array<{ contentId: string; id: string; key: string }>;
  /** Makes an id for each new copy and resource. Passed in so the planner stays pure and tests are deterministic. */
  newId: () => string;
  /** Overrides FORK_ENTRY_CAP (tests only). */
  cap?: number;
};

export type ForkPlan = {
  /** Copies to INSERT, in a stable order. */
  copies: Array<{ originalId: string; copyId: string; copyKey: string; type: ContentType; name: string; isArchived: boolean }>;
  /** Originals that already have a copy here. Never overwritten (the DM may have edited it). */
  reused: Array<{ originalId: string; copyId: string }>;
  /** original id -> copy id, for every entry in the set (new and reused). Used to re-point uses and references. */
  idRemap: Record<string, string>;
  /** original condition key -> copy key, to rewrite deck rules_json. */
  keyRemap: Record<string, string>;
  /** original resource definition id -> copy resource definition id (new rows are created for new copies). */
  resourceRemap: Record<string, string>;
  /** New resource definitions to INSERT for new copies. */
  newResources: Array<{ originalId: string; copyId: string; copyContentId: string }>;
  /** Roots that were not the owner's personal entries, left alone and reported. */
  skipped: Array<{ id: string; reason: string }>;
};

export class ForkPlanError extends Error {}

/**
 * Works out what a fork would copy and how everything maps across, without touching anything.
 * The set is the roots plus everything reachable from them through references, restricted to the owner's own personal
 * entries (another owner's entries, and global ones, are referenced as they are). It only ever adds: there is no
 * delete in a plan, and an existing copy is reused rather than rewritten.
 */
export function planFork(input: ForkInput): ForkPlan {
  const cap = input.cap ?? FORK_ENTRY_CAP;
  const eligible = new Map<string, ForkEntry>();
  for (const entry of input.entries) {
    if (entry.scope === 'personal' && entry.ownerUserId === input.ownerUserId) eligible.set(entry.id, entry);
  }

  const skipped: ForkPlan['skipped'] = [];
  const queue: string[] = [];
  const inSet = new Set<string>();
  const add = (id: string) => { if (!inSet.has(id)) { inSet.add(id); queue.push(id); } };
  for (const id of [...input.roots].sort()) {
    if (eligible.has(id)) add(id);
    else skipped.push({ id, reason: 'not a personal entry of this owner' });
  }

  // Closure: follow references until nothing new turns up.
  const edgesFrom = new Map<string, string[]>();
  for (const edge of input.edges) edgesFrom.set(edge.from, [...(edgesFrom.get(edge.from) ?? []), edge.to]);
  for (let i = 0; i < queue.length; i += 1) {
    if (inSet.size > cap) break;
    for (const to of (edgesFrom.get(queue[i]) ?? []).slice().sort()) if (eligible.has(to)) add(to);
  }
  if (inSet.size > cap) {
    throw new ForkPlanError(`Refusing to copy more than ${cap} entries (found over ${cap}). Something is badly wrong.`);
  }

  const existing = new Map(input.existingCopies.map((copy) => [copy.originalId, copy]));
  const plan: ForkPlan = { copies: [], reused: [], idRemap: {}, keyRemap: {}, resourceRemap: {}, newResources: [], skipped };
  const resourcesOf = (rows: ForkInput['originalResources'], contentId: string) => rows.filter((row) => row.contentId === contentId);

  for (const id of queue) {
    const original = eligible.get(id)!;
    const copy = existing.get(id);
    if (copy) {
      plan.reused.push({ originalId: id, copyId: copy.copyId });
      plan.idRemap[id] = copy.copyId;
      plan.keyRemap[original.key] = copy.copyKey;
      // Map each original resource to the existing copy's resource with the same key (Unit G must copy resources with their original keys).
      for (const resource of resourcesOf(input.originalResources, id)) {
        const match = resourcesOf(input.copyResources, copy.copyId).find((row) => row.key === resource.key);
        if (match) plan.resourceRemap[resource.id] = match.id;
      }
      continue;
    }
    const copyId = input.newId();
    const copyKey = `fork:${input.campaignId}:${id}`;
    plan.copies.push({ originalId: id, copyId, copyKey, type: original.type, name: original.name, isArchived: original.isArchived });
    plan.idRemap[id] = copyId;
    plan.keyRemap[original.key] = copyKey;
    for (const resource of resourcesOf(input.originalResources, id)) {
      const newResourceId = input.newId();
      plan.resourceRemap[resource.id] = newResourceId;
      plan.newResources.push({ originalId: resource.id, copyId: newResourceId, copyContentId: copyId });
    }
  }
  return plan;
}
