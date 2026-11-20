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

/** Shown to a self-serve player for an area + category with nothing to find. Deliberately vague. */
export const NOTHING_HERE_TEXT = "You don't think you'll find anything like that here.";

const CATEGORY_LABELS = { plant: 'Plants', ore: 'Ores', gem: 'Gems', scroll: 'Scrolls', misc: 'Miscellaneous' };

/** Plain-language label for an area type or category tag: "cave" -> "Cave", "ore" -> "Ores". */
export function tagLabel(tag) {
  if (CATEGORY_LABELS[tag]) return CATEGORY_LABELS[tag];
  return String(tag || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// ===============================================================================================
// SELF-SERVE PLAYER helpers: a player never gets table names, ids or counts, only plain area +
// category pairs, so nothing here may take or show a table.
// ===============================================================================================
// `options` is the server's list of { areaType, category } pairs that have something pickable.

export function selfAreas(options) {
  return unique((options || []).map((o) => o.areaType)).sort();
}
export function selfCategories(options) {
  return unique((options || []).map((o) => o.category)).sort();
}
export function selfPairExists(options, areaType, category) {
  return (options || []).some((o) => o.areaType === areaType && o.category === category);
}

/** Starting self-serve picks: saved ones where valid, else the first area and a category that pairs with it. */
export function defaultSelfPicks(skills, options, saved) {
  const areas = selfAreas(options);
  const areaType = areas.includes(saved?.areaType) ? saved.areaType : areas[0] || '';
  const categories = selfCategories(options);
  const pairedFirst = (options || []).find((o) => o.areaType === areaType)?.category || '';
  const category = categories.includes(saved?.category) ? saved.category : pairedFirst;
  const skillKeys = (skills || []).map((skill) => skill.key);
  return { skillKey: skillKeys.includes(saved?.skillKey) ? saved.skillKey : skillKeys[0] || '', areaType, category };
}

export function canSubmitSelf(options, picks) {
  return SELF_SKILL_KEYS.includes(picks.skillKey) && selfPairExists(options, picks.areaType, picks.category);
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
  if (result.outcome === 'failed') return 'You find nothing of note.';
  return result.lines && result.lines.length ? 'You found something.' : 'You find nothing of note.';
}

// --- Button labels -------------------------------------------------------------------------

/** The label on a token card's Forage button. */
export function forageButtonLabel({ pending, hasResult }) {
  if (pending) return 'Forage (waiting)';
  if (hasResult) return 'Forage (result)';
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
  return lines.length > 0 && lines.every((line) => Number.isInteger(line.qty) && line.qty >= 1 && line.qty <= MAX_QTY);
}

export function linesPayload(lines) {
  return lines.map((line) => ({ itemId: line.itemId, qty: line.qty }));
}

// --- Errors --------------------------------------------------------------------------------

const ERROR_TEXT = {
  not_found: "That character wasn't found.",
  bad_skill: 'Pick a skill.',
  bad_table: "That table isn't available any more.",
  table_empty: "You don't think you'll find anything like that here.",
  nothing_here: "You don't think you'll find anything like that here.",
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
  approve_failed: "Couldn't add the haul. Nothing was changed, try again.",
  server_error: 'Something went wrong on the server.',
  network: "Couldn't reach the server."
};

export function errorText(data) {
  const code = data && data.error;
  if (code === 'invalid_lines' && data.message) return data.message;
  return ERROR_TEXT[code] || 'Something went wrong.';
}
