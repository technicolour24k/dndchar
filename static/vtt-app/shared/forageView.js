// @ts-nocheck - plain browser JS (no build step, so no type annotations); svelte-check reaches it only via the vitest import.
// Pure helpers for the VTT forage popups (vtt-forage plan, unit C). No DOM, no fetch, so they can be
// unit tested from src/ (see src/lib/server/vttForageView.test.ts) and the browser imports the same file.

// Suggestions for the category picker, on top of whatever the active tables use. Mirrors
// DEFAULT_FORAGE_CATEGORIES in src/lib/rules/forage.ts (this file is unbundled and can't import it).
export const DEFAULT_CATEGORIES = ['plant', 'ore', 'gem', 'scroll', 'misc'];

/** The same shared key the character sheet uses for a player's last SELF-SERVE picks (unit E). */
export const LAST_PICKS_KEY = 'forage_last_player';
/** The DM's own last picks (skill, area, category) for the GM popup. GM side only. */
export const LAST_GM_PICKS_KEY = 'vtt_forage_last_gm';

/**
 * The only skills a player can pick for a self-serve forage. MIRRORS FORAGE_SELF_SKILLS in
 * src/lib/rules/skills.ts (the server enforces it). A test asserts the two match.
 */
export const SELF_SKILL_KEYS = ['nature', 'survival', 'arcana', 'perception', 'investigation', 'religion'];

const CATEGORY_LABELS = { plant: 'Plants', ore: 'Ores', gem: 'Gems', scroll: 'Scrolls', misc: 'Miscellaneous' };

/** Plain-language label for an area type or category tag: "cave" -> "Cave", "ore" -> "Ores". */
export function tagLabel(tag) {
  if (CATEGORY_LABELS[tag]) return CATEGORY_LABELS[tag];
  return String(tag || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ===============================================================================================
// SELF-SERVE PLAYER helpers: a player never gets table names, ids or counts, only plain area and
// category tags, so nothing here may take or show a table.
// ===============================================================================================
// `options` is { areas, categories }: two separate tag lists from the server, never pairs, so they
// say nothing about which combinations have something to find. Any area + category can be foraged;
// one with nothing behind it rolls and marks like any other and a pass just finds nothing.

export function selfAreas(options) {
  return [...(options?.areas || [])];
}
export function selfCategories(options) {
  return [...(options?.categories || [])];
}

/** Starting self-serve picks: saved ones where still listed, else the first of each list. */
export function defaultSelfPicks(skills, options, saved) {
  const areas = selfAreas(options);
  const categories = selfCategories(options);
  const skillKeys = (skills || []).map((skill) => skill.key);
  return {
    skillKey: skillKeys.includes(saved?.skillKey) ? saved.skillKey : skillKeys[0] || '',
    areaType: areas.includes(saved?.areaType) ? saved.areaType : areas[0] || '',
    category: categories.includes(saved?.category) ? saved.category : categories[0] || ''
  };
}

export function canSubmitSelf(options, picks) {
  return SELF_SKILL_KEYS.includes(picks.skillKey) && selfAreas(options).includes(picks.areaType)
    && selfCategories(options).includes(picks.category);
}

const unique = (values) => [...new Set(values)];

// ===============================================================================================
// GM POPUP helpers: the DM sees every table, so these work on the full table list (names, counts).
// ===============================================================================================

/** Area types that have at least one active table, sorted. */
export function areaOptions(tables) {
  return unique((tables || []).map((table) => table.areaType)).sort();
}

/** Category suggestions: the defaults first, then any extra categories the tables use. */
export function categoryOptions(tables) {
  const extra = unique((tables || []).map((table) => table.category)).filter((c) => !DEFAULT_CATEGORIES.includes(c)).sort();
  return [...DEFAULT_CATEGORIES, ...extra];
}

/** The active table for an area type + category, or null. */
export function resolveTable(tables, areaType, category) {
  return (tables || []).find((table) => table.areaType === areaType && table.category === category) || null;
}

/** Tables that can actually be rolled on (something pickable). */
export function pickableTables(tables) {
  return (tables || []).filter((table) => table.pickableCount > 0);
}

/**
 * The table a pick set resolves to: the manual "Use table" choice if there is one, else the table
 * for the area + category. Null when neither exists.
 */
export function chosenTable(tables, picks) {
  if (picks.manualTableId) {
    const manual = (tables || []).find((table) => table.id === picks.manualTableId);
    if (manual) return manual;
  }
  return resolveTable(tables, picks.areaType, picks.category);
}

/** One line under the pickers: which table was resolved, and whether it can be used. */
// DM-only short label for an entry's chance, e.g. "Rare 10%". Mirrors CHANCE_OPTIONS in src/lib/rules/forage.ts
// (a test keeps them in step). Players never see it: only the GM popup's add-item list uses it.
const CHANCE_NAMES = { 100: 'Guaranteed', 50: 'Very Common', 30: 'Common', 20: 'Uncommon', 10: 'Rare', 5: 'Very Rare', 1: 'Ultra Rare' };
export function chanceLabel(chance) {
  if (!chance) return 'Off';
  return CHANCE_NAMES[chance] ? `${CHANCE_NAMES[chance]} ${chance}%` : `${chance}%`;
}

export function tableLineText(table, picks) {
  if (!table) return `No table for ${picks.areaType || '?'} + ${picks.category || '?'}. Pick one below.`;
  if (table.pickableCount === 0) return `${table.name} is empty, so there is nothing to find.`;
  return `${table.name} · ${table.pickableCount} pickable`;
}

/** Reads the shared last-picks value. Anything unexpected gives {}. */
export function parseSavedPicks(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object') return {};
    const text = (v) => (typeof v === 'string' ? v : '');
    return { skillKey: text(value.skillKey), areaType: text(value.areaType), category: text(value.category) };
  } catch {
    return {};
  }
}

/** Starting picks: the saved ones where they are still valid, else the first sensible option. */
export function defaultPicks(skills, tables, saved) {
  const areas = areaOptions(tables);
  const categories = categoryOptions(tables);
  const pick = (value, list) => (list.includes(value) ? value : list[0] || '');
  return {
    skillKey: pick(saved?.skillKey, (skills || []).map((skill) => skill.key)),
    areaType: pick(saved?.areaType, areas),
    category: pick(saved?.category, categories),
    manualTableId: ''
  };
}

/** The player can press Forage only with a usable table and no request already in flight. */
export function canSubmitPicks(tables, picks) {
  const table = chosenTable(tables, picks);
  return !!picks.skillKey && !!table && table.pickableCount > 0;
}

// --- Check display -------------------------------------------------------------------------

export function natBadgeText(check) {
  if (!check) return '';
  if (check.nat20) return 'Natural 20';
  if (check.nat1) return 'Natural 1';
  return '';
}

/** "Nature 17", with the kept natural die in brackets. */
export function checkHeadline(check) {
  if (!check) return '';
  return `${check.skillLabel} ${check.total} (d20: ${check.natural})`;
}

// --- Result wording ------------------------------------------------------------------------

/**
 * Normalises the two result shapes (a DM-mode forage:closed result, and the self-serve self_mark
 * response) into one: { outcome: 'failed' | 'approved' | 'cancelled', check, lines, findId, mode }.
 */
export function selfResult(markResponse, findId, characterId) {
  return {
    outcome: markResponse.status === 'found' ? 'approved' : 'failed',
    check: markResponse.check || null,
    lines: markResponse.lines || [],
    findId: findId || null,
    characterId: characterId || null,
    mode: 'self'
  };
}

export function dmResult(result) {
  return { ...result, mode: 'dm' };
}

/** The headline for a closed forage. An approved haul with no lines reads as nothing found. */
export function resultHeadline(result) {
  if (!result) return '';
  if (result.outcome === 'cancelled') return 'The DM cancelled the forage.';
  if (result.outcome === 'failed') return "You didn't find anything.";
  return result.lines && result.lines.length ? 'You found something.' : "You didn't find anything.";
}

// --- Button labels -------------------------------------------------------------------------

// --- Unavailable (find tables belong to campaigns) -------------------------------------------------

// Why a character can't forage. Campaign-level reasons only, never anything about individual tables
// (Rev 4), so a player learns "your DM hasn't set it up" and nothing more. The server's codes are
// 'no_campaign' | 'wrong_room' | 'no_tables'.
const UNAVAILABLE_TEXT = {
  no_campaign: 'Add this character to a campaign to forage.',
  wrong_room: "Foraging isn't available in this room.",
  no_tables: "Your DM hasn't set up foraging for this campaign yet."
};

export function forageUnavailableText(reason) {
  return UNAVAILABLE_TEXT[reason] || "Foraging isn't available right now.";
}

/**
 * The reason to show instead of a live Forage button, or '' when the button should work. Unavailable
 * only counts when there's nothing in flight to finish: a pending request, an unmarked check or a
 * waiting result keeps the button live, so a started forage can always be completed.
 */
export function forageUnavailableReason(mine, characterId) {
  if (!mine || mine.available !== false) return '';
  if (forageBlocker(mine, characterId) || lastDmFor(mine, characterId)) return '';
  return mine.unavailableReason || 'no_tables';
}

/** The label on a token card's Forage button. */
export function forageButtonLabel({ pending, hasResult, unavailable = '' }) {
  if (pending) return 'Forage (waiting)';
  if (hasResult) return 'Forage (result)';
  if (unavailable) return 'Forage (unavailable)';
  return 'Forage';
}

// --- GM queue ------------------------------------------------------------------------------

/** The GM's pending requests, oldest first. */
export function sortedRequests(forageMap) {
  return Object.values(forageMap || {}).filter((request) => request && request.id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
}

const STAGE_LABEL = { requested: 'new', checked: 'checked', preview: 'haul', approving: 'approving' };

export function queueLabel(request) {
  return `${request.playerName || 'Player'} (${STAGE_LABEL[request.stage] || request.stage})`;
}

/**
 * A fingerprint of the parts of a request that, when changed, mean the GM popup body must be
 * rebuilt (stage, and the rolled haul), as opposed to a harmless repeat of the same state.
 */
export function requestSignature(request) {
  const lines = request.preview ? request.preview.lines.map((line) => `${line.itemId}:${line.qty}`).join(',') : '';
  return [request.id, request.stage, request.check ? request.check.total : '', request.preview ? request.preview.tableId : '', lines].join('|');
}

// --- GM haul editing (immutable, small) ----------------------------------------------------

export const MAX_QTY = 999;

/** Clamps typed text to a whole number 1..999, or null if it isn't one. */
export function parseQty(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) return null;
  return Math.min(n, MAX_QTY);
}

export function setLineQty(lines, itemId, qty) {
  return lines.map((line) => (line.itemId === itemId ? { ...line, qty } : line));
}

export function removeLine(lines, itemId) {
  return lines.filter((line) => line.itemId !== itemId);
}

/** Adds a table entry as a quantity-1 line. No-op for an item already there. */
export function addLine(lines, entry) {
  if (lines.some((line) => line.itemId === entry.itemId)) return lines;
  return [...lines, { itemId: entry.itemId, name: entry.name, qty: 1 }];
}

/** Table entries that can still be added: not already a line, not archived. */
export function addableEntries(tableEntries, lines) {
  const used = new Set(lines.map((line) => line.itemId));
  return (tableEntries || []).filter((entry) => !used.has(entry.itemId) && !entry.archived);
}

export function canApprove(lines) {
  // An empty haul can be approved: with independent chances a pass can find nothing.
  return lines.every((line) => Number.isInteger(line.qty) && line.qty >= 1 && line.qty <= MAX_QTY);
}

export function linesPayload(lines) {
  return lines.map((line) => ({ itemId: line.itemId, qty: line.qty }));
}

// --- Character sheet helpers (unit E) --------------------------------------------------------------
// `mine` is the GET /vtt/api/forage/mine response. A closed DM-mode result belongs to one character, so
// the sheet only treats it as its own when characterId matches. The unmarked self check is per user.

/** The result of the last DM-mode forage, if it is this character's. */
export function lastDmFor(mine, characterId) {
  const last = mine && mine.lastDm;
  return last && last.characterId === characterId ? last : null;
}

/**
 * The forage blocking this user (one in flight per USER, not per character): a pending DM request or an
 * unmarked self-serve check. `mine` says whose it is, so a sheet can tell its own from another character's.
 * Returns { kind: 'pending' | 'unmarked', characterId, characterName, isThisCharacter } or null.
 */
export function forageBlocker(mine, characterId) {
  if (!mine) return null;
  if (mine.pending) {
    const who = mine.pendingCharacter || {};
    // An older response with no character info is treated as this character's.
    return { kind: 'pending', characterId: who.id || characterId, characterName: who.name || 'your character', isThisCharacter: !who.id || who.id === characterId };
  }
  if (mine.unmarkedSelf) {
    const u = mine.unmarkedSelf;
    return { kind: 'unmarked', characterId: u.characterId, characterName: u.characterName || 'your character', isThisCharacter: u.characterId === characterId };
  }
  return null;
}

/** Badge on the sheet's Forage button: 'waiting', 'mark check', 'result' or ''. Only for THIS character's forage. */
export function forageBadgeText(mine, characterId) {
  const blocker = forageBlocker(mine, characterId);
  if (blocker && blocker.isThisCharacter) return blocker.kind === 'pending' ? 'waiting' : 'mark check';
  if (lastDmFor(mine, characterId)) return 'result';
  return '';
}

/** A key for a DM-approved haul that put items in this character's inventory, else null. */
export function approvedHaulKey(mine, characterId) {
  const last = lastDmFor(mine, characterId);
  return last && last.outcome === 'approved' && last.lines && last.lines.length ? String(last.requestId) : null;
}

/**
 * Should a DM-approved haul reload the sheet? Pure, so the rules are testable:
 *   - no approved haul for this character, or one already handled: nothing
 *   - closed before the sheet mounted (`mountedAt`, on the SERVER clock): it is already in the rows the
 *     sheet loaded, so nothing (the caller still records the key)
 *   - otherwise 'reload', or 'defer' when there are unsaved edits (the rows then show on Save)
 * `handled` is a Set of keys the caller has already acted on. Returns { key, action }.
 */
export function haulDecision({ mine, characterId, mountedAt, handled, hasUnsavedChanges }) {
  const key = approvedHaulKey(mine, characterId);
  if (!key || handled.has(key)) return { key: null, action: 'none' };
  const closedAt = lastDmFor(mine, characterId).closedAt;
  if (typeof closedAt === 'number' && closedAt < mountedAt) return { key, action: 'none' };
  return { key, action: hasUnsavedChanges ? 'defer' : 'reload' };
}

/** The net adv/dis readout for the sheet popup (the VTT draws the same sentence in main.js). */
export function forageAdvReadout({ sources, disabled, adv, dis }) {
  const off = new Set(disabled || []);
  const ticked = (sources || []).filter((source) => !off.has(source.id));
  const advantage = ticked.filter((source) => source.kind === 'advantage').length + adv;
  const disadvantage = ticked.filter((source) => source.kind === 'disadvantage').length + dis;
  if (advantage === 0 && disadvantage === 0) return 'Flat roll';
  const net = advantage - disadvantage;
  const counts = `(${advantage} adv, ${disadvantage} dis)`;
  if (net === 0) return `Net 0 ${counts}: flat roll`;
  return `Net ${net > 0 ? '+' : ''}${net} ${counts}: roll ${1 + Math.abs(net)}d20, keep ${net > 0 ? 'highest' : 'lowest'}`;
}

// --- "Recent finds" (the owner's own list, shared by the VTT popup and the character sheet) -------
// Rows come from GET /vtt/api/forage/recent: { id, createdAt, status: 'found' | 'reverted', mode,
// shared, items: [{ name, qty }], revertNote }. There is no table name anywhere in them (Rev 4).

/** "3x Moonleaf, 2x Iron Ore", or a plain note when the haul is empty. */
export function recentFindItemsText(find) {
  const items = (find && find.items) || [];
  return items.length ? items.map((item) => `${item.qty}x ${item.name}`).join(', ') : 'Nothing recorded';
}

/** Share is offered only on a standing find with items that hasn't been shared yet. */
export function canShareRecent(find) {
  return !!find && find.status === 'found' && !find.shared && Array.isArray(find.items) && find.items.length > 0;
}

/** Short status words for a row: shared, undone (with the note), self-served. Empty parts are dropped. */
export function recentFindStatusText(find) {
  if (!find) return '';
  const parts = [];
  parts.push(find.mode === 'self' ? 'self-served' : 'DM-approved');
  if (find.status === 'reverted') parts.push(find.revertNote ? `undone by the DM (${find.revertNote})` : 'undone by the DM');
  else if (find.shared) parts.push('shared with the party');
  return parts.join(' · ');
}

// --- Errors --------------------------------------------------------------------------------

const ERROR_TEXT = {
  not_found: "That character wasn't found.",
  bad_skill: 'Pick a skill.',
  bad_table: "That table isn't available any more.",
  table_empty: "You don't think you'll find anything like that here.",
  bad_pick: 'Pick an area and a category.',
  skill_not_allowed: 'Pick one of the listed skills.',
  not_in_room: "You aren't in that room.",
  bad_token: "That token isn't yours.",
  not_gm: "Open the VTT from the app's VTT link to run forage.",
  stale: 'That check was already marked.',
  stale_request: 'That request has gone (withdrawn, cancelled or already handled).',
  wrong_stage: 'That request has moved on. Refreshing.',
  cannot_withdraw: 'The DM is here, so you can only withdraw before they roll.',
  busy: 'Still working on the last action, try again in a moment.',
  invalid_lines: 'Those quantities were not accepted.',
  session_not_found: 'That room has closed.',
  character_not_found: "That character wasn't found.",
  forbidden: "That isn't your find to share.",
  not_shareable: "Only a find that's still standing can be shared.",
  approve_failed: "Couldn't add the haul. Nothing was changed, try again.",
  server_error: 'Something went wrong on the server.',
  forage_unavailable: "Foraging isn't available right now.",
  network: "Couldn't reach the server."
};

export function errorText(data) {
  const code = data && data.error;
  if (code === 'invalid_lines' && data.message) return data.message;
  if (code === 'forage_unavailable') return forageUnavailableText(data.reason);
  return ERROR_TEXT[code] || 'Something went wrong.';
}
