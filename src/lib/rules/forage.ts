import type {
  FindLine, FindMode, FindStatus, FindTableEntry, ForageCatalogue, ForageCatalogueTable, ForageUnavailableReason
} from '$lib/types/forage';

// Pure helpers for find tables, plus the roll itself (below). No DB; randomness is injected.

/** Suggestions for the area/category inputs. Free text still wins, so homebrew stays easy. */
export const DEFAULT_FORAGE_CATEGORIES = ['plant', 'ore', 'gem', 'scroll', 'misc'];

/** Area types and categories are stored trimmed, lower-cased, with inner whitespace collapsed. */
export function normaliseTag(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function parseInteger(value: unknown): number | null {
  if (typeof value === 'number') return Number.isInteger(value) ? value : null;
  const text = String(value ?? '').trim();
  return /^-?\d+$/.test(text) ? Number(text) : null;
}

export type ParsedTableInput = {
  name: string;
  areaType: string;
  category: string;
  suggestedCheck: string;
};

/** Validates the table form fields. Throws an Error with a user-facing message. */
export function parseTableInput(raw: {
  name?: unknown; areaType?: unknown; category?: unknown; suggestedCheck?: unknown;
}): ParsedTableInput {
  const name = String(raw.name ?? '').trim();
  if (!name || name.length > 80) throw new Error('Table name must be 1 to 80 characters.');
  const areaType = normaliseTag(raw.areaType);
  if (!areaType || areaType.length > 40) throw new Error('Area type must be 1 to 40 characters.');
  const category = normaliseTag(raw.category);
  if (!category || category.length > 40) throw new Error('Category must be 1 to 40 characters.');
  const suggestedCheck = String(raw.suggestedCheck ?? '').trim();
  if (suggestedCheck.length > 80) throw new Error('Suggested check must be 80 characters or fewer.');
  return { name, areaType, category, suggestedCheck };
}

/**
 * The chance choices for a find table entry: a label and the stored percent. Each pickable entry is
 * rolled on its own (d100 <= chance), so these percentages are true. 0 is "Off": the entry stays on
 * the table but is never found (and doesn't count as pickable). Off goes last in the dropdown.
 * migration 038's CHECK constraint must list the same values.
 */
export const CHANCE_OPTIONS: ReadonlyArray<{ label: string; percent: number }> = [
  { label: 'Guaranteed (100% chance)', percent: 100 },
  { label: 'Very Common (50% chance)', percent: 50 },
  { label: 'Common (30% chance)', percent: 30 },
  { label: 'Uncommon (20% chance)', percent: 20 },
  { label: 'Rare (10% chance)', percent: 10 },
  { label: 'Very Rare (5% chance)', percent: 5 },
  { label: 'Ultra Rare (1% chance)', percent: 1 },
  { label: 'Off (never found)', percent: 0 }
];

/** What a new entry starts at (Common). */
export const DEFAULT_CHANCE = 30;

export type ParsedEntryInput = { chance: number; qtyDie: number };

/** Validates one entry's chance and quantity die. Throws an Error with a user-facing message. */
export function parseEntryInput(raw: { chance?: unknown; qtyDie?: unknown }): ParsedEntryInput {
  const chance = parseInteger(raw.chance);
  if (chance === null || !CHANCE_OPTIONS.some((option) => option.percent === chance)) {
    throw new Error('Pick a chance from the list.');
  }
  const qtyDie = parseInteger(raw.qtyDie);
  if (qtyDie === null || qtyDie < 1) throw new Error('Quantity die must be 1 or more (1 means always one).');
  if (qtyDie > 100) throw new Error('Quantity die must be 100 or fewer.');
  return { chance, qtyDie };
}

/** An entry can be rolled if it has a chance above 0 (not Off) and its item is not archived. */
export function isPickable(entry: Pick<FindTableEntry, 'chance' | 'itemArchived'>): boolean {
  return entry.chance > 0 && !entry.itemArchived;
}

export function pickableEntries<T extends Pick<FindTableEntry, 'chance' | 'itemArchived'>>(entries: T[]): T[] {
  return entries.filter(isPickable);
}

/** One campaign's active tables (find tables belong to a campaign, there are no shared ones). */
export function tablesForCampaign<T extends { campaignId: string; isArchived: boolean }>(tables: T[], campaignId: string | null | undefined): T[] {
  if (!campaignId) return [];
  return tables.filter((table) => !table.isArchived && table.campaignId === campaignId);
}

export type ForageAvailability = { available: true } | { available: false; reason: ForageUnavailableReason };

/**
 * Can this character forage right now? Campaign-level facts only (the result says nothing about
 * individual tables, so a player never learns which combinations exist).
 *  - no campaign -> 'no_campaign'
 *  - the forage lands in a live room that isn't the character's campaign room (a Quick room, or
 *    another campaign's) -> 'wrong_room'
 *  - the campaign has no active table with something pickable -> 'no_tables'
 * Inside an available campaign, an area + category with no table still rolls and finds nothing.
 */
export function forageAvailability(input: {
  characterCampaignId: string | null | undefined;
  roomCampaignId: string | null | undefined;
  inLiveRoom: boolean;
  tables: Array<{ campaignId: string; isArchived: boolean; pickableCount: number }>;
}): ForageAvailability {
  if (!input.characterCampaignId) return { available: false, reason: 'no_campaign' };
  if (input.inLiveRoom && input.roomCampaignId !== input.characterCampaignId) return { available: false, reason: 'wrong_room' };
  const usable = tablesForCampaign(input.tables, input.characterCampaignId).some((table) => table.pickableCount > 0);
  return usable ? { available: true } : { available: false, reason: 'no_tables' };
}

/** The active table for an area type + category, or null. Archived tables never match. */
export function resolveTable(
  catalogue: ForageCatalogue,
  areaType: string,
  category: string
): ForageCatalogueTable | null {
  const area = normaliseTag(areaType);
  const cat = normaliseTag(category);
  return catalogue.tables.find((table) => !table.isArchived && table.areaType === area && table.category === cat) ?? null;
}

// --- The roll (unit B) ---------------------------------------------------------------------
// All randomness goes through an injected rollDie(sides), returning 1..sides (the attackRoll.ts
// convention), so tests can script the dice.

export type RollDie = (sides: number) => number;

/** Biggest quantity on one result line, matching addInventoryItem's 999 cap. */
export const MAX_FIND_QTY = 999;
const MAX_FIND_LINES = 50;

/**
 * One run: every pickable entry is rolled on its own. d100 <= chance means it is found, then its
 * quantity die (1dN, d1 is always one) is rolled. So a run can find several items, or none. Dice are
 * rolled in table order: the d100 for an entry, then (only if found) its quantity die.
 */
export function rollFindRun(entries: FindTableEntry[], rollDie: RollDie): FindLine[] {
  const lines: FindLine[] = [];
  for (const entry of pickableEntries(entries)) {
    if (rollDie(100) <= entry.chance) lines.push({ itemId: entry.itemId, qty: rollDie(entry.qtyDie) });
  }
  return lines;
}

/** A full find: one run, or two on a nat 20. Lines are merged by item so repeats stack. */
export function rollFind(
  entries: FindTableEntry[], nat20: boolean, rollDie: RollDie
): { lines: FindLine[]; runs: number } {
  const runs = nat20 ? 2 : 1;
  const merged = new Map<string, number>();
  for (let run = 0; run < runs; run++) {
    for (const line of rollFindRun(entries, rollDie)) {
      merged.set(line.itemId, (merged.get(line.itemId) ?? 0) + line.qty);
    }
  }
  return { lines: [...merged].map(([itemId, qty]) => ({ itemId, qty })), runs };
}

export type ValidatedLines = { ok: true; lines: FindLine[] } | { ok: false; error: string };

/**
 * Checks lines a client sent for approval (and the server's own self-serve haul, same rules).
 * 1..50 lines (or none at all when allowEmpty: a successful forage can find nothing), each an item
 * on THIS table with a live item (any chance, so the DM can add an Off entry by hand), whole-number
 * qty 1..cap, no duplicates.
 */
export function validateFindLines(rawLines: unknown, entries: FindTableEntry[], cap = MAX_FIND_QTY, allowEmpty = false): ValidatedLines {
  if (!Array.isArray(rawLines)) return { ok: false, error: 'There is nothing to approve.' };
  if (rawLines.length === 0 && !allowEmpty) return { ok: false, error: 'There is nothing to approve.' };
  if (rawLines.length > MAX_FIND_LINES) return { ok: false, error: `At most ${MAX_FIND_LINES} lines.` };
  const byItem = new Map(entries.map((entry) => [entry.itemId, entry]));
  const seen = new Set<string>();
  const lines: FindLine[] = [];
  for (const raw of rawLines) {
    const itemId = typeof raw?.itemId === 'string' ? raw.itemId : '';
    const entry = byItem.get(itemId);
    if (!entry) return { ok: false, error: 'That item is not on this table.' };
    if (entry.itemArchived) return { ok: false, error: `${entry.itemName} is archived.` };
    if (seen.has(itemId)) return { ok: false, error: `${entry.itemName} appears twice.` };
    const qty = raw.qty;
    if (typeof qty !== 'number' || !Number.isInteger(qty) || qty < 1 || qty > cap) {
      return { ok: false, error: `Quantity for ${entry.itemName} must be a whole number from 1 to ${cap}.` };
    }
    seen.add(itemId);
    lines.push({ itemId, qty });
  }
  return { ok: true, lines };
}

/** "Found 3 items" counts total quantity, not distinct items (Q4). */
export function forageItemCount(lines: FindLine[]): number {
  return lines.reduce((sum, line) => sum + line.qty, 0);
}

// ---------------------------------------------------------------------------------------------
// Per-viewer finds (unit D). The session summary and the admin list both come through here, so the
// "who sees item names" rule lives in one pure, tested place.
// ---------------------------------------------------------------------------------------------

/** "Nature 17", or "Nature natural 20" / "Nature natural 1" when the kept die was a 20 or a 1. */
export function findCheckSummary(check: { skillLabel?: string; total?: number; nat20?: boolean; nat1?: boolean } | null | undefined): string {
  if (!check || !check.skillLabel) return '';
  const roll = check.nat20 ? 'natural 20' : check.nat1 ? 'natural 1' : String(check.total ?? '');
  return `${check.skillLabel} ${roll}`.trim();
}

/** What everyone without full access reads. Never contains an item name, a table or a check. */
export function redactedFindText(status: FindStatus, characterName: string, itemCount: number): string {
  if (status === 'reverted') return `${characterName}'s find was undone by the DM.`;
  if (status === 'found' && itemCount > 0) return `${characterName} foraged and found ${itemCount} ${itemCount === 1 ? 'item' : 'items'}.`;
  return `${characterName} foraged and found nothing of note.`;
}

/** A find as loaded for the summary: everything, before the viewer is known. */
export type FindForViewer = {
  id: string; createdAt: string; status: FindStatus; mode: FindMode; shared: boolean;
  characterName: string; finderUserId: string; characterOwnerId: string;
  check: { skillLabel?: string; total?: number; nat20?: boolean; nat1?: boolean } | null;
  tableName: string; items: Array<{ name: string; qty: number }>; revertNote: string;
};

export type SessionFindView =
  | {
    view: 'full'; id: string; createdAt: string; status: FindStatus; mode: FindMode; shared: boolean; canShare: boolean;
    characterName: string; checkSummary: string; tableName: string; items: Array<{ name: string; qty: number }>;
    itemCount: number; revertNote: string;
  }
  | { view: 'redacted'; id: string; createdAt: string; status: FindStatus; text: string };

/**
 * Full detail for the DM (the Game Session owner or an admin), for the finder (and the character's
 * owner), and for everyone once the find has been shared (while it still stands). Everyone else gets
 * one line with a count only. canShare is true only for the finder on an unshared, standing find.
 */
export function shapeFindForViewer(find: FindForViewer, viewer: { id: string; isDm: boolean }): SessionFindView {
  const itemCount = find.items.reduce((sum, item) => sum + item.qty, 0);
  const isFinder = viewer.id === find.finderUserId || viewer.id === find.characterOwnerId;
  const full = viewer.isDm || isFinder || (find.shared && find.status === 'found');
  if (!full) {
    return { view: 'redacted', id: find.id, createdAt: find.createdAt, status: find.status, text: redactedFindText(find.status, find.characterName, itemCount) };
  }
  return {
    view: 'full', id: find.id, createdAt: find.createdAt, status: find.status, mode: find.mode, shared: find.shared,
    canShare: isFinder && find.status === 'found' && !find.shared && itemCount > 0, // nothing to share on an empty find
    characterName: find.characterName, checkSummary: findCheckSummary(find.check),
    // Rev 4: players learn nothing about tables, even for their own finds. Only the DM sees the name.
    tableName: viewer.isDm ? find.tableName : '',
    items: find.items, itemCount, revertNote: find.revertNote
  };
}

/** The public roll-log line for a share. The only place item names go in the log (explicit share). */
export function shareLogMessage(characterName: string, items: Array<{ name: string; qty: number }>): string {
  return `${characterName} shared their find: ${items.map((item) => `${item.name} x${item.qty}`).join(', ')}.`;
}

/** The public roll-log line for an admin undo. No item names. */
export function undoLogMessage(characterName: string): string {
  return `The DM undid ${characterName}'s find.`;
}
