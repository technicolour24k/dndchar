import crypto from 'node:crypto';
import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { cachedReference, invalidateReferenceData } from '$lib/server/cache/referenceData';
import { getCampaignAccess, getCharacterAccess, isUuid } from '$lib/server/services/access';
import { loadCampaignLibraries, loadLibraryActor } from '$lib/server/services/library';
import { applyCharacterEffect } from '$lib/server/services/effects';
import { primeSheetAc } from '$lib/server/vttTokenAc';
import { collectConditionKeys, summariseDeck, type DeckSummary } from '$lib/rules/deckAdmin';
import {
  applyCoin, applyHp, applyTempHp, cardSuccess, cardValue, describeLine, needsValueChoice, parseDeckRules, planDraw, type RollDie
} from '$lib/rules/decks';
import type {
  DeckCard, DeckCoin, DmTask, DrawResultLine, DrawStatus, DrawView, ExpandedDeckRules, PlannedLine
} from '$lib/types/decks';

// Decks: draw a card, apply the outcome to the party, undo it. A deck is a Container whose rules are data
// (see src/lib/rules/decks.ts); this service is the only place that touches the database for them.
//
// LOCK ORDER (also noted next to cost-engine.ts's): a draw locks the affected `characters` rows in ascending id,
// then their hp / temp_hp `character_resources` rows, which is the whole-sheet Save's order. Two draws over the
// same party therefore queue instead of deadlocking.

export type DeckErrorCode = 'choosing' | 'not_enabled' | 'already_undone' | 'not_found' | 'forbidden' | 'bad_input' | 'not_choosing';

/** `draw` accompanies 'choosing': the undecided draw the player has to finish first. */
export class DeckError extends Error {
  constructor(public code: DeckErrorCode, message: string, public draw?: DrawView) {
    super(message);
  }
}

const COIN_KEY: Record<DeckCoin, string> = { cp: 'currencyCp', sp: 'currencySp', ep: 'currencyEp', gp: 'currencyGp', pp: 'currencyPp' };

/** Randomness and card choice can be injected (tests); production uses crypto. */
export type DeckDeps = { cardId?: string; rollDie?: RollDie };
const secureDie: RollDie = (sides) => crypto.randomInt(1, sides + 1);

export type LoadedDeck = { id: string; name: string; description: string; archived: boolean; rules: ExpandedDeckRules };

/** Parsed deck rules, cached per deck (an admin write invalidates the reference cache). */
export async function loadDeck(contentId: string): Promise<LoadedDeck | null> {
  if (!isUuid(contentId)) return null;
  return cachedReference(`deck:${contentId}`, async () => {
    const result = await query<any>(
      `SELECT c.id, c.name, c.description, c.is_archived, d.rules_json
       FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id WHERE c.id = $1 AND c.content_type = 'deck'`, [contentId]);
    const row = result.rows[0];
    if (!row) return null;
    const parsed = parseDeckRules(row.rules_json);
    if (!parsed.rules) throw new Error(`Deck "${row.name}" has invalid rules: ${parsed.errors[0]}`);
    return { id: row.id, name: row.name, description: row.description, archived: row.is_archived, rules: parsed.rules } as LoadedDeck;
  });
}

export type CampaignDeck = { id: string; name: string; description: string; archived: boolean; enabled: boolean };

export async function listCampaignDecks(campaignId: string, opts: { includeDisabled?: boolean } = {}): Promise<CampaignDeck[]> {
  if (!isUuid(campaignId)) return [];
  const result = await query<any>(
    `SELECT c.id, c.name, c.description, c.is_archived, cd.is_enabled
     FROM campaign_decks cd JOIN content_definitions c ON c.id = cd.deck_content_id JOIN deck_definitions d ON d.content_id = c.id
     WHERE cd.campaign_id = $1 AND ${IN_USE_SQL}
       AND ($2::boolean OR (cd.is_enabled AND NOT c.is_archived)) ORDER BY c.name`,
    [campaignId, Boolean(opts.includeDisabled)]);
  return result.rows.map((row) => ({ id: row.id, name: row.name, description: row.description, archived: row.is_archived, enabled: row.is_enabled }));
}

// ---------------------------------------------------------------- views

const DRAW_SELECT = `
  SELECT d.*, c.name AS deck_name, ch.name AS drawer_name
  FROM deck_draws d JOIN content_definitions c ON c.id = d.deck_content_id JOIN characters ch ON ch.id = d.drawer_character_id`;

function toView(row: any): DrawView {
  return {
    id: row.id, deckId: row.deck_content_id, deckName: row.deck_name, campaignId: row.campaign_id,
    drawerCharacterId: row.drawer_character_id, drawerName: row.drawer_name, card: row.card_json, success: row.success,
    chosenValue: row.chosen_value, status: row.status as DrawStatus, outcome: row.outcome_json ?? {}, results: row.results ?? [],
    dmTasks: row.dm_tasks ?? [], createdAt: new Date(row.created_at).toISOString(),
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    revertedAt: row.reverted_at ? new Date(row.reverted_at).toISOString() : null, revertNote: row.revert_note ?? ''
  };
}

async function loadDrawRow(client: pg.PoolClient | { query: typeof query }, drawId: string, lock = false): Promise<any | null> {
  if (!isUuid(drawId)) return null;
  const result = await (client as any).query(`${DRAW_SELECT} WHERE d.id = $1 ${lock ? 'FOR UPDATE OF d' : ''}`, [drawId]);
  return result.rows[0] ?? null;
}

/** What each option of an undecided card would do (dice shown at their minimum, so numbers cards are exact). */
async function previewsFor(view: DrawView): Promise<Record<string, string>> {
  const card = view.card as DeckCard;
  if (!needsValueChoice(card)) return {};
  const deck = await loadDeck(view.deckId);
  if (!deck) return {};
  const party = await partyIds({ query }, view.campaignId, view.drawerCharacterId);
  const names = await characterNames({ query }, party);
  const previews: Record<string, string> = {};
  for (const option of card.valueOptions ?? []) {
    const plan = planDraw({
      rules: deck.rules, card: card as DeckCard, success: view.success, chosenValue: option, drawerId: view.drawerCharacterId,
      partyIds: party, rollDie: () => 1
    });
    previews[String(option)] = [...plan.lines.map((line) => describeLine(line, names)), ...plan.tasks.map((task) => task.text)].join('. ') || plan.outcome.text;
  }
  return previews;
}

async function partyIds(db: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }, campaignId: string, drawerId: string): Promise<string[]> {
  const result = await db.query(
    `SELECT id FROM characters WHERE campaign_id = $1 AND (party_active OR id = $2) ORDER BY id`, [campaignId, drawerId]);
  return result.rows.map((row) => row.id);
}

async function characterNames(db: { query: (text: string, params?: any[]) => Promise<{ rows: any[] }> }, ids: string[]): Promise<Record<string, string>> {
  if (!ids.length) return {};
  const result = await db.query('SELECT id, name FROM characters WHERE id = ANY($1::uuid[])', [ids]);
  return Object.fromEntries(result.rows.map((row) => [row.id, row.name]));
}

/** The draws screens: decks the character's campaign has enabled, an undecided draw, and the last few. */
export async function listDecksForCharacter(userId: string, characterId: string): Promise<{ decks: CampaignDeck[]; choosing: DrawView | null; recent: DrawView[] }> {
  const access = await getCharacterAccess({ query }, userId, characterId);
  if (!access || !access.canView) throw new DeckError('not_found', 'Character not found.');
  const campaign = await query<{ campaign_id: string | null }>('SELECT campaign_id FROM characters WHERE id = $1', [characterId]);
  const campaignId = campaign.rows[0]?.campaign_id;
  if (!campaignId) return { decks: [], choosing: null, recent: [] };
  const decks = await listCampaignDecks(campaignId);
  const choosingRow = (await query<any>(`${DRAW_SELECT} WHERE d.drawer_character_id = $1 AND d.status = 'choosing'`, [characterId])).rows[0];
  const choosing = choosingRow ? toView(choosingRow) : null;
  if (choosing) choosing.previews = await previewsFor(choosing);
  const recent = (await query<any>(`${DRAW_SELECT} WHERE d.campaign_id = $1 AND d.status <> 'cancelled' ORDER BY d.created_at DESC LIMIT 5`, [campaignId])).rows.map(toView);
  return { decks, choosing, recent };
}

// ---------------------------------------------------------------- drawing

/** A weighted pick (card `copies`), uniform over cards otherwise. */
function pickCard(rules: ExpandedDeckRules, forcedId?: string): DeckCard {
  if (forcedId) {
    const forced = rules.cards.find((card) => card.id === forcedId);
    if (!forced) throw new DeckError('bad_input', `No card "${forcedId}" in this deck.`);
    return forced;
  }
  const total = rules.cards.reduce((sum, card) => sum + (card.copies ?? 1), 0);
  if (!total) throw new DeckError('bad_input', 'This deck has no cards.');
  let ticket = crypto.randomInt(0, total);
  for (const card of rules.cards) {
    ticket -= card.copies ?? 1;
    if (ticket < 0) return card;
  }
  return rules.cards[rules.cards.length - 1];
}

export type DrawResult = { status: 'choosing' | 'resolved'; draw: DrawView };

export async function drawCard(input: { userId: string; characterId: string; deckId: string; roomCode?: string | null; deps?: DeckDeps }): Promise<DrawResult> {
  const { userId, characterId, deckId } = input;
  const access = await getCharacterAccess({ query }, userId, characterId);
  if (!access || !access.canAct) throw new DeckError('forbidden', 'Character not found.');
  const character = (await query<any>(
    `SELECT c.campaign_id, cp.room_code, cp.is_archived FROM characters c LEFT JOIN campaigns cp ON cp.id = c.campaign_id WHERE c.id = $1`, [characterId])).rows[0];
  if (!character?.campaign_id || character.is_archived) throw new DeckError('not_enabled', 'This character is not in an active campaign.');
  const campaignId: string = character.campaign_id;
  const enabled = await query(
    `SELECT 1 FROM campaign_decks cd JOIN content_definitions c ON c.id = cd.deck_content_id JOIN deck_definitions d ON d.content_id = c.id
     WHERE cd.campaign_id = $1 AND cd.deck_content_id = $2 AND cd.is_enabled AND NOT c.is_archived AND ${IN_USE_SQL}`, [campaignId, deckId]);
  if (!enabled.rows.length) throw new DeckError('not_enabled', 'That deck is not enabled for this campaign.');
  const deck = await loadDeck(deckId);
  if (!deck) throw new DeckError('not_found', 'Deck not found.');

  // Tokens with no AC baseline get one from the pre-draw AC, so they still follow this draw's AC change.
  await primeParty(campaignId, characterId);
  const card = pickCard(deck.rules, input.deps?.cardId);
  const success = cardSuccess(deck.rules, card);
  const status: DrawStatus = needsValueChoice(card) ? 'choosing' : 'resolved';

  let drawId: string;
  try {
    drawId = await withTransaction(async (client) => {
      // Lock the whole party (ascending id) BEFORE inserting the draw: the insert takes a key-share lock on the
      // drawer's character row, and two drawers inserting first would then deadlock over each other's rows.
      await client.query(`SELECT id FROM characters WHERE ${PARTY_SQL} ORDER BY id FOR UPDATE`, [campaignId, characterId]);
      const existing = await client.query('SELECT 1 FROM deck_draws WHERE drawer_character_id = $1 AND status = \'choosing\'', [characterId]);
      if (existing.rows.length) throw new DeckError('choosing', 'Finish the card you drew first.');
      const session = await client.query('SELECT id FROM game_sessions WHERE campaign_id = $1 AND is_active ORDER BY created_at DESC LIMIT 1', [campaignId]);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO deck_draws (deck_content_id, campaign_id, drawer_character_id, drawer_user_id, room_code, game_session_id, card_json, success, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, 'choosing') RETURNING id`,
        [deckId, campaignId, characterId, userId, character.room_code ?? input.roomCode ?? null, session.rows[0]?.id ?? null, JSON.stringify(card), success]);
      const id = inserted.rows[0].id;
      if (status === 'resolved') await resolveDraw(client, id, null, input.deps);
      return id;
    });
  } catch (error) {
    // The partial unique index is the real guard against two simultaneous Ace draws.
    if ((error as any)?.code === '23505') throw new DeckError('choosing', 'Finish the card you drew first.', await currentChoosing(characterId));
    if (error instanceof DeckError && error.code === 'choosing') throw new DeckError('choosing', error.message, await currentChoosing(characterId));
    throw error;
  }
  const draw = toView((await loadDrawRow({ query }, drawId))!);
  if (draw.status === 'choosing') draw.previews = await previewsFor(draw);
  return { status: draw.status === 'choosing' ? 'choosing' : 'resolved', draw };
}

/** Unit 5b step 0. Best effort: a failure here must never stop a draw. */
async function primeParty(campaignId: string, drawerId: string): Promise<void> {
  try { await primeSheetAc(await partyIds({ query }, campaignId, drawerId)); } catch (error) { console.error('[decks] AC prime failed', error); }
}

async function currentChoosing(characterId: string): Promise<DrawView | undefined> {
  const row = (await query<any>(`${DRAW_SELECT} WHERE d.drawer_character_id = $1 AND d.status = 'choosing'`, [characterId])).rows[0];
  if (!row) return undefined;
  const view = toView(row);
  view.previews = await previewsFor(view);
  return view;
}

/** The Ace: the drawer picks 1 or 11. Resolves against the stored card and the deck's current rules. */
export async function chooseValue(input: { userId: string; drawId: string; value: number; deps?: DeckDeps }): Promise<DrawView> {
  const row = await loadDrawRow({ query }, input.drawId);
  if (!row) throw new DeckError('not_found', 'Draw not found.');
  const access = await getCharacterAccess({ query }, input.userId, row.drawer_character_id);
  if (!access || !access.canAct) throw new DeckError('forbidden', 'Draw not found.');
  await primeParty(row.campaign_id, row.drawer_character_id);
  await withTransaction(async (client) => {
    const locked = await loadDrawRow(client, input.drawId, true);
    if (!locked || locked.status !== 'choosing') throw new DeckError('not_choosing', 'This draw has already been decided.');
    try { cardValue(locked.card_json, input.value); } catch (error) { throw new DeckError('bad_input', (error as Error).message); }
    await resolveDraw(client, input.drawId, input.value, input.deps);
  });
  return toView((await loadDrawRow({ query }, input.drawId))!);
}

// ---------------------------------------------------------------- applying

type ResourceRow = { hp?: { current: number; max: number }; temp?: { current: number; max: number } };

type LockTarget = string[] | { campaignId: string; drawerId: string };
const PARTY_SQL = 'campaign_id = $1 AND (party_active OR id = $2)';

/**
 * Locks the characters (ascending id) then their hp/temp_hp rows, and returns what is needed to apply lines.
 * Given a party (campaign + drawer) the party is READ UNDER THE LOCK (one FOR UPDATE statement; Postgres re-checks
 * the predicate after waiting), so a member added or removed meanwhile is neither missed nor stale.
 */
async function lockTargets(client: pg.PoolClient, target: LockTarget) {
  const characters = Array.isArray(target)
    ? await client.query<any>('SELECT id, name, metadata_json FROM characters WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [Array.from(new Set(target))])
    : await client.query<any>(`SELECT id, name, metadata_json FROM characters WHERE ${PARTY_SQL} ORDER BY id FOR UPDATE`, [target.campaignId, target.drawerId]);
  const sorted: string[] = characters.rows.map((row) => row.id);
  const resources = await client.query<any>(
    `SELECT character_id, resource_key, current_value, max_value FROM character_resources
     WHERE character_id = ANY($1::uuid[]) AND resource_key IN ('hp', 'temp_hp') ORDER BY character_id, resource_key FOR UPDATE`, [sorted]);
  const meta = new Map<string, Record<string, unknown>>(characters.rows.map((row) => [row.id, { ...(row.metadata_json ?? {}) }]));
  const names: Record<string, string> = Object.fromEntries(characters.rows.map((row) => [row.id, row.name]));
  const res = new Map<string, ResourceRow>();
  for (const row of resources.rows) {
    const entry = res.get(row.character_id) ?? {};
    const value = { current: row.current_value, max: row.max_value };
    if (row.resource_key === 'hp') entry.hp = value; else entry.temp = value;
    res.set(row.character_id, entry);
  }
  return { partyIds: sorted, meta, names, res, dirtyMeta: new Set<string>(), dirtyRes: new Set<string>() };
}

async function writeResources(client: pg.PoolClient, state: Awaited<ReturnType<typeof lockTargets>>) {
  for (const id of Array.from(state.dirtyRes).sort()) {
    const entry = state.res.get(id)!;
    if (entry.hp) await client.query(`UPDATE character_resources SET current_value = $2 WHERE character_id = $1 AND resource_key = 'hp'`, [id, entry.hp.current]);
    if (entry.temp) {
      await client.query(`UPDATE character_resources SET current_value = $2, max_value = GREATEST(max_value, $2) WHERE character_id = $1 AND resource_key = 'temp_hp'`, [id, entry.temp.current]);
      entry.temp.max = Math.max(entry.temp.max, entry.temp.current);
    }
  }
}

async function resolveDraw(client: pg.PoolClient, drawId: string, chosenValue: number | null, deps: DeckDeps = {}): Promise<void> {
  const row = await loadDrawRow(client, drawId, true);
  const card: DeckCard = row.card_json;
  const deck = await loadDeck(row.deck_content_id);
  if (!deck) throw new DeckError('not_found', 'Deck not found.');
  const state = await lockTargets(client, { campaignId: row.campaign_id, drawerId: row.drawer_character_id });
  const plan = planDraw({
    rules: deck.rules, card, success: row.success, chosenValue, drawerId: row.drawer_character_id, partyIds: state.partyIds, rollDie: deps.rollDie ?? secureDie
  });
  const results: DrawResultLine[] = [];
  const tasks: DmTask[] = plan.tasks.map((task) => ({ id: crypto.randomUUID(), text: task.text, characterIds: task.characterIds, done: false, doneByUserId: null, doneAt: null }));
  const addTask = (text: string, characterIds: string[]) => tasks.push({ id: crypto.randomUUID(), text, characterIds, done: false, doneByUserId: null, doneAt: null });

  for (const line of plan.lines) {
    const text = describeLine(line, state.names);
    const base = { characterId: line.characterId, kind: line.kind, requested: line.amount, text } as const;
    const who = state.names[line.characterId] ?? 'Someone';
    if (line.kind === 'coin') {
      const coin = line.coin ?? 'gp';
      const key = COIN_KEY[coin];
      const meta = state.meta.get(line.characterId);
      if (!meta) { results.push({ ...base, coin, before: 0, after: 0, note: 'Character not found.' }); continue; }
      const before = Number(meta[key]) || 0;
      const { after, shortfall } = applyCoin(before, line.amount);
      meta[key] = after;
      state.dirtyMeta.add(line.characterId);
      results.push({ ...base, coin, before, after, ...(shortfall ? { note: `Had ${before} ${coin}, lost ${before - after}, ${shortfall} short.` } : {}) });
    } else if (line.kind === 'hp') {
      const entry = state.res.get(line.characterId);
      if (!entry?.hp) { results.push({ ...base, before: 0, after: 0, note: `${who} has no HP to change.` }); continue; }
      const temp = entry.temp?.current ?? 0;
      const next = applyHp({ hp: entry.hp.current, max: entry.hp.max, temp }, line.amount);
      results.push({ ...base, before: entry.hp.current, after: next.hp, tempBefore: temp, tempAfter: next.temp, ...(next.note ? { note: next.note } : {}) });
      entry.hp.current = next.hp;
      if (entry.temp) entry.temp.current = next.temp;
      state.dirtyRes.add(line.characterId);
    } else if (line.kind === 'temp_hp') {
      const entry = state.res.get(line.characterId);
      if (!entry?.temp) { results.push({ ...base, before: 0, after: 0, note: `${who} has no temp HP row.` }); continue; }
      const next = applyTempHp(entry.temp.current, line.amount);
      results.push({ ...base, before: entry.temp.current, after: next.temp, ...(next.note ? { note: next.note } : {}) });
      entry.temp.current = next.temp;
      state.dirtyRes.add(line.characterId);
    } else {
      const applied = await applyConditionLine(client, row, line, state.names);
      results.push({ ...base, before: 0, after: 0, conditionKey: line.conditionKey, ...applied.result });
      if (applied.task) addTask(applied.task, [line.characterId]);
    }
  }
  await flushMeta(client, state);
  await writeResources(client, state);

  await client.query(
    `UPDATE deck_draws SET status = 'resolved', chosen_value = $2, outcome_json = $3::jsonb, results = $4::jsonb, dm_tasks = $5::jsonb, resolved_at = now() WHERE id = $1`,
    [drawId, chosenValue, JSON.stringify(plan.outcome), JSON.stringify(results), JSON.stringify(tasks)]);
}

async function flushMeta(client: pg.PoolClient, state: Awaited<ReturnType<typeof lockTargets>>) {
  for (const id of Array.from(state.dirtyMeta).sort()) {
    await client.query('UPDATE characters SET metadata_json = $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(state.meta.get(id))]);
  }
}

/**
 * Applies one condition line through the normal effect path. A missing/archived/unavailable condition becomes a DM task.
 * Which conditions a key may resolve to follows the deck (the same rule the editor validates with, in saveDeckCore,
 * except that "libraries enabled" becomes "owner is still a member": a deck that already names a library condition keeps
 * working when the DM later switches that library off; visibility gates new use, never what is already referenced).
 */
async function applyConditionLine(client: pg.PoolClient, draw: any, line: PlannedLine, names: Record<string, string>): Promise<{ result: Partial<DrawResultLine>; task?: string }> {
  const container = await client.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM content_definitions c, content_definitions deck
     WHERE c.content_key = $1 AND c.content_type = 'condition' AND NOT c.is_archived AND deck.id = $2
       AND ((c.scope = 'global' AND c.owner_user_id IS NULL)
         OR (c.scope = 'personal' AND deck.scope = 'personal' AND c.owner_user_id = deck.owner_user_id)
         OR (c.scope = 'campaign' AND deck.scope = 'campaign' AND c.campaign_id = deck.campaign_id)
         OR (c.scope = 'personal' AND deck.scope = 'campaign'
             AND EXISTS (SELECT 1 FROM campaign_members m WHERE m.campaign_id = deck.campaign_id AND m.user_id = c.owner_user_id)))`,
    [line.conditionKey, draw.deck_content_id]);
  const who = names[line.characterId] ?? 'Someone';
  if (!container.rows.length) {
    // A library key is condition:library:<userId>:<slug>:<hex>: show the slug, not the ids.
    const parts = (line.conditionKey ?? 'condition').replace(/^condition:/, '').split(':');
    const label = (parts[0] === 'library' && parts.length >= 4 ? parts[parts.length - 2] : parts.join(':')).replace(/[_-]/g, ' ');
    return { result: { note: `Condition "${line.conditionKey}" is unavailable.` }, task: `Apply ${label} to ${who} by hand (${line.sourceLabel})` };
  }
  const applied = await applyCharacterEffect(client, line.characterId, container.rows[0].id, {
    params: line.params, remainingRounds: line.durationRounds ?? null, sourceLabel: line.sourceLabel,
    sourceCharacterId: draw.drawer_character_id, metadata: { deckDrawId: draw.id }
  });
  if (applied.status === 'rejected' || !applied.rowId) return { result: { note: `${container.rows[0].name} was not applied.` } };
  return { result: { effectRowId: applied.rowId } };
}

// ---------------------------------------------------------------- undo and tasks

/** DM/co-DM (or site admin) undo. Reverses what was actually applied, clamped, and says what could not be reversed. */
export async function revertDraw(input: { userId: string; drawId: string }): Promise<DrawView> {
  const head = await loadDrawRow({ query }, input.drawId);
  if (!head) throw new DeckError('not_found', 'Draw not found.');
  const access = await getCampaignAccess({ query }, input.userId, head.campaign_id);
  if (!access?.canManage) throw new DeckError('forbidden', 'Only the DM can undo a draw.');

  await withTransaction(async (client) => {
    const row = await loadDrawRow(client, input.drawId, true);
    if (row.status === 'reverted' || row.status === 'cancelled') throw new DeckError('already_undone', 'That draw was already undone.');
    if (row.status === 'choosing') {
      await client.query(`UPDATE deck_draws SET status = 'cancelled', reverted_at = now(), reverted_by_user_id = $2, revert_note = 'Cancelled before a value was chosen.' WHERE id = $1`, [row.id, input.userId]);
      return;
    }
    const lines: DrawResultLine[] = row.results ?? [];
    const state = await lockTargets(client, lines.map((line) => line.characterId));
    const notes: string[] = [];
    for (const line of lines) {
      const who = state.names[line.characterId] ?? 'Someone';
      if (line.kind === 'coin') {
        const meta = state.meta.get(line.characterId);
        const key = COIN_KEY[line.coin ?? 'gp'];
        const applied = line.after - line.before;
        if (!meta || !applied) continue;
        const current = Number(meta[key]) || 0;
        const next = Math.max(0, current - applied);
        if (next !== current - applied) notes.push(`${who}: could only take back ${current - next} of ${applied} ${line.coin}.`);
        meta[key] = next;
        state.dirtyMeta.add(line.characterId);
      } else if (line.kind === 'hp') {
        const entry = state.res.get(line.characterId);
        const hpDelta = line.after - line.before;
        const tempDelta = (line.tempAfter ?? 0) - (line.tempBefore ?? 0);
        if (!entry?.hp || (!hpDelta && !tempDelta)) continue;
        const wantHp = entry.hp.current - hpDelta;
        const hp = Math.max(0, Math.min(entry.hp.max, wantHp));
        if (hp !== wantHp) notes.push(`${who}: HP could not be fully restored.`);
        entry.hp.current = hp;
        if (entry.temp && tempDelta) entry.temp.current = Math.max(0, entry.temp.current - tempDelta);
        state.dirtyRes.add(line.characterId);
      } else if (line.kind === 'temp_hp') {
        const entry = state.res.get(line.characterId);
        const delta = line.after - line.before;
        if (!entry?.temp || !delta) continue;
        const want = entry.temp.current - delta;
        if (want < 0) notes.push(`${who}: temp HP could not be fully taken back.`);
        entry.temp.current = Math.max(0, want);
        state.dirtyRes.add(line.characterId);
      } else if (line.effectRowId) {
        const gone = await client.query('DELETE FROM active_character_effects WHERE id = $1 AND character_id = $2', [line.effectRowId, line.characterId]);
        if (!gone.rowCount) notes.push(`${who}: ${line.text} had already expired.`);
      }
    }
    await flushMeta(client, state);
    await writeResources(client, state);
    const tasks: DmTask[] = (row.dm_tasks ?? []).map((task: DmTask) =>
      task.done ? task : { ...task, done: true, doneByUserId: input.userId, doneAt: new Date().toISOString() });
    await client.query(
      `UPDATE deck_draws SET status = 'reverted', reverted_at = now(), reverted_by_user_id = $2, revert_note = $3, dm_tasks = $4::jsonb WHERE id = $1`,
      [row.id, input.userId, notes.join(' '), JSON.stringify(tasks)]);
  });
  return toView((await loadDrawRow({ query }, input.drawId))!);
}

export async function setDrawTaskDone(input: { userId: string; drawId: string; taskId: string; done: boolean }): Promise<DrawView> {
  const head = await loadDrawRow({ query }, input.drawId);
  if (!head) throw new DeckError('not_found', 'Draw not found.');
  const access = await getCampaignAccess({ query }, input.userId, head.campaign_id);
  if (!access?.canManage) throw new DeckError('forbidden', 'Only the DM can mark a task done.');
  await withTransaction(async (client) => {
    const row = await loadDrawRow(client, input.drawId, true);
    const tasks: DmTask[] = row.dm_tasks ?? [];
    if (!tasks.some((task) => task.id === input.taskId)) throw new DeckError('not_found', 'Task not found.');
    const next = tasks.map((task) => task.id !== input.taskId ? task
      : { ...task, done: input.done, doneByUserId: input.done ? input.userId : null, doneAt: input.done ? new Date().toISOString() : null });
    await client.query('UPDATE deck_draws SET dm_tasks = $2::jsonb WHERE id = $1', [row.id, JSON.stringify(next)]);
  });
  return toView((await loadDrawRow({ query }, input.drawId))!);
}

export async function setCampaignDeck(input: { userId: string; campaignId: string; deckId: string; enabled: boolean }): Promise<void> {
  if (!isUuid(input.deckId)) throw new DeckError('bad_input', 'Pick a deck.');
  const access = await getCampaignAccess({ query }, input.userId, input.campaignId);
  if (!access?.canManage) throw new DeckError('forbidden', 'Only the DM can change the campaign\'s decks.');
  if (access.archived) throw new DeckError('bad_input', 'This campaign is archived, so its decks can no longer be changed.');
  // A campaign can use global decks, its own, and decks of libraries enabled in it, never another campaign's or a
  // library that is off (it looks like a missing deck). A deck already attached can always be switched OFF, even if
  // its library has since been switched off (visibility gates new use, never what is already in use).
  const owners = (await loadCampaignLibraries({ query }, input.campaignId)).enabledOwnerIds;
  const deck = await query<{ is_archived: boolean }>(
    `SELECT c.is_archived FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id
     WHERE c.id = $1 AND c.content_type = 'deck'
       AND (${DECK_VISIBLE_SQL('$2', '$3')}
         OR (NOT $4::boolean AND EXISTS (SELECT 1 FROM campaign_decks cd WHERE cd.campaign_id = $2 AND cd.deck_content_id = c.id)))`,
    [input.deckId, input.campaignId, owners, input.enabled]);
  if (!deck.rows.length) throw new DeckError('not_found', 'Deck not found.');
  if (input.enabled && deck.rows[0].is_archived) throw new DeckError('bad_input', 'That deck is archived.');
  await query(
    `INSERT INTO campaign_decks (campaign_id, deck_content_id, is_enabled, added_by_user_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (campaign_id, deck_content_id) DO UPDATE SET is_enabled = EXCLUDED.is_enabled`,
    [input.campaignId, input.deckId, input.enabled, input.userId]);
}

/** Campaign members (and site admins) can read the draw log. */
export async function listDrawsForCampaign(userId: string, campaignId: string, opts: { limit?: number } = {}): Promise<DrawView[]> {
  const access = await getCampaignAccess({ query }, userId, campaignId);
  if (!access?.canView) throw new DeckError('forbidden', 'Campaign not found.');
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));
  const result = await query<any>(`${DRAW_SELECT} WHERE d.campaign_id = $1 ORDER BY d.created_at DESC LIMIT $2`, [campaignId, limit]);
  return result.rows.map(toView);
}

export type OpenDmTask = { drawId: string; taskId: string; text: string; characterIds: string[]; cardLabel: string; deckName: string; createdAt: string };

/** Open DM tasks of resolved draws, oldest first. DM/co-DM (or admin) only. */
export async function listOpenDmTasks(userId: string, campaignId: string): Promise<OpenDmTask[]> {
  const access = await getCampaignAccess({ query }, userId, campaignId);
  if (!access?.canManage) throw new DeckError('forbidden', 'Only the DM can see the open tasks.');
  const result = await query<any>(`${DRAW_SELECT} WHERE d.campaign_id = $1 AND d.status = 'resolved' AND d.dm_tasks @> '[{"done": false}]'::jsonb ORDER BY d.created_at ASC`, [campaignId]);
  return result.rows.flatMap((row) => (row.dm_tasks as DmTask[]).filter((task) => !task.done).map((task) => ({
    drawId: row.id, taskId: task.id, text: task.text, characterIds: task.characterIds, cardLabel: row.card_json.label,
    deckName: row.deck_name, createdAt: new Date(row.created_at).toISOString()
  })));
}

/**
 * Stores the HP delta that was nudged onto a live VTT token (results[index].tokenHpDeltas, by token id), so an undo can reverse
 * exactly that. Accepted tiny window: an undo that lands between the commit and this write finds no stored delta and
 * leaves the tokens alone (the DM can nudge by hand). Written after the draw commits (the VTT is not part of the transaction), and only on a resolved draw.
 */
export async function recordTokenHpDeltas(drawId: string, deltas: Array<{ index: number; deltas: Record<string, number> }>): Promise<void> {
  if (!deltas.length || !isUuid(drawId)) return;
  await withTransaction(async (client) => {
    const row = await loadDrawRow(client, drawId, true);
    if (!row || row.status !== 'resolved') return;
    const results: DrawResultLine[] = row.results ?? [];
    for (const { index, deltas: perToken } of deltas) if (results[index] && results[index].kind === 'hp') results[index].tokenHpDeltas = perToken;
    await client.query('UPDATE deck_draws SET results = $2::jsonb WHERE id = $1', [drawId, JSON.stringify(results)]);
  });
}

// ---------------------------------------------------------------- campaign deck authoring (unit 9b)
// A deck a DM creates is OWNED BY THE CAMPAIGN (content_definitions.campaign_id, scope 'campaign') and exists only there. Global decks
// (scope 'global', campaign_id NULL, e.g. the seeded Deck of Mystical Fate) are read-only: a DM copies one into the campaign to edit
// it. Every function here checks canManage on the campaign (DM / co-DM, plus the site-admin override) and, for
// writes, that the campaign is not archived and that the deck is one the campaign owns. Decks are archived, never deleted.

const DECK_RULES_MAX_CHARS = 300_000;

/** SQL fragment for decks ALREADY in campaign_decks (alias cd): they keep working whatever their library does. Another campaign's own deck never matches. */
const IN_USE_SQL = `(c.scope <> 'campaign' OR c.campaign_id = cd.campaign_id)`;

/**
 * SQL fragment, for NEW use: a deck may be offered to or enabled for a campaign when it is global, owned by that
 * campaign, or a personal deck of a library enabled there (ownersParam is a uuid[] of the enabled owners).
 */
const DECK_VISIBLE_SQL = (campaignParam: string, ownersParam: string) =>
  `(c.scope = 'global' OR (c.scope = 'campaign' AND c.campaign_id = ${campaignParam}) OR (c.scope = 'personal' AND c.owner_user_id = ANY(${ownersParam}::uuid[])))`;

async function requireManage(userId: string, campaignId: string, opts: { write: boolean }): Promise<void> {
  const access = await getCampaignAccess({ query }, userId, campaignId);
  if (!access?.canManage) throw new DeckError('forbidden', 'Only the DM can manage this campaign\'s decks.');
  if (opts.write && access.archived) throw new DeckError('bad_input', 'This campaign is archived, so its decks can no longer be changed.');
}

/** Decks a campaign could add: global or its own, not archived, and not already attached (enabled or not). */
export async function listAvailableDecks(campaignId: string): Promise<Array<{ id: string; name: string }>> {
  if (!isUuid(campaignId)) return [];
  const owners = (await loadCampaignLibraries({ query }, campaignId)).enabledOwnerIds;
  const result = await query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id
     WHERE c.content_type = 'deck' AND NOT c.is_archived AND ${DECK_VISIBLE_SQL('$1', '$2')}
       AND NOT EXISTS (SELECT 1 FROM campaign_decks cd WHERE cd.campaign_id = $1 AND cd.deck_content_id = c.id)
     ORDER BY c.name`, [campaignId, owners]);
  return result.rows;
}

export type ManagedDeckRow = {
  id: string; name: string; archived: boolean; cardCount: number | null; enabled: boolean; invalid: boolean;
  /** Library decks only: whose library it is, whether that is the viewer's own, and whether it is switched on here. */
  ownerName: string | null; mine: boolean; libraryOn: boolean;
};

/**
 * The deck management page's lists: this campaign's own decks, the global decks (read-only, copyable) and decks from
 * libraries (read-only, referenced, never copied: only Enable/Disable). A library deck already attached is always
 * listed, even if its library is now off, so the DM can disable it. `canSaveToLibrary` shows the Save button.
 */
export async function listDecksForManagement(userId: string, campaignId: string): Promise<{ own: ManagedDeckRow[]; global: ManagedDeckRow[]; library: ManagedDeckRow[]; canSaveToLibrary: boolean }> {
  await requireManage(userId, campaignId, { write: false });
  const owners = (await loadCampaignLibraries({ query }, campaignId)).enabledOwnerIds;
  const result = await query<any>(
    `SELECT c.id, c.name, c.is_archived, c.scope, c.owner_user_id, u.display_name AS owner_name, d.rules_json,
            COALESCE(cd.is_enabled, false) AS enabled
     FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id
     LEFT JOIN users u ON u.id = c.owner_user_id AND c.scope = 'personal'
     LEFT JOIN campaign_decks cd ON cd.deck_content_id = c.id AND cd.campaign_id = $1
     WHERE c.content_type = 'deck' AND (${DECK_VISIBLE_SQL('$1', '$2')} OR (cd.deck_content_id IS NOT NULL AND ${IN_USE_SQL}))
     ORDER BY c.is_archived, c.name`, [campaignId, owners]);
  const rows = result.rows.map((row) => {
    const parsed = parseDeckRules(row.rules_json);
    return {
      scope: row.scope as string,
      archivedAndOff: Boolean(row.is_archived) && !row.enabled,
      row: {
        id: row.id, name: row.name, archived: row.is_archived, cardCount: parsed.rules?.cards.length ?? null, enabled: row.enabled, invalid: !parsed.rules,
        ownerName: row.scope === 'personal' ? (row.owner_name ?? 'someone') : null,
        mine: row.scope === 'personal' && row.owner_user_id === userId,
        libraryOn: row.scope === 'personal' && owners.includes(row.owner_user_id)
      } as ManagedDeckRow
    };
  });
  const actor = await loadLibraryActor({ query }, userId);
  return {
    own: rows.filter((entry) => entry.scope === 'campaign').map((entry) => entry.row),
    global: rows.filter((entry) => entry.scope === 'global' && !entry.row.archived).map((entry) => entry.row),
    // An archived library deck that is not attached is not worth listing; an attached one is, so it can be disabled.
    library: rows.filter((entry) => entry.scope === 'personal' && !entry.archivedAndOff).map((entry) => entry.row),
    canSaveToLibrary: actor.canAuthorMechanics
  };
}

export type AdminDeck = {
  id: string; name: string; description: string; archived: boolean; rulesText: string;
  errors: string[]; warnings: string[]; summary: DeckSummary | null;
  cards: Array<{ id: string; label: string; needsValue: boolean }>;
};

// ---------------------------------------------------------------- shared editing core (campaign decks and personal decks)
// A deck is edited the same way wherever it lives; only WHO MAY EDIT IT differs. So the write functions below take a
// DeckOwner (the ownership the deck must have, checked as part of every query) and the public wrappers do the access check:
//   campaign decks: canManage on that campaign (requireManage);
//   personal decks: the owner, and for anything that writes rules, mechanics rights (requirePersonal).

type DeckOwner = { kind: 'campaign'; campaignId: string } | { kind: 'personal'; userId: string };

/** SQL condition (alias `c`) that matches only decks with this ownership. `param` is the placeholder holding the owner's id. */
const ownedBy = (owner: DeckOwner, param: string) =>
  owner.kind === 'campaign' ? `c.campaign_id = ${param}` : `(c.scope = 'personal' AND c.owner_user_id = ${param})`;
const ownerId = (owner: DeckOwner) => (owner.kind === 'campaign' ? owner.campaignId : owner.userId);

/** Personal decks: rules are mechanics, so writing them is DM/admin only (checked per write, not remembered). */
async function requirePersonal(userId: string, opts: { write: boolean }): Promise<void> {
  const actor = await loadLibraryActor({ query }, userId);
  if (opts.write && !actor.canAuthorMechanics) throw new DeckError('forbidden', 'Decks are for DMs and admins, because their rules count as mechanics.');
}

async function getDeckCore(owner: DeckOwner, deckId: string): Promise<AdminDeck | null> {
  if (!isUuid(deckId)) return null;
  const result = await query<any>(
    `SELECT c.id, c.name, c.description, c.is_archived, d.rules_json FROM content_definitions c
     JOIN deck_definitions d ON d.content_id = c.id WHERE c.id = $1 AND c.content_type = 'deck' AND ${ownedBy(owner, '$2')}`, [deckId, ownerId(owner)]);
  const row = result.rows[0];
  if (!row) return null;
  const parsed = parseDeckRules(row.rules_json);
  return {
    id: row.id, name: row.name, description: row.description, archived: row.is_archived,
    rulesText: JSON.stringify(row.rules_json, null, 2), errors: parsed.errors, warnings: parsed.warnings,
    summary: parsed.rules ? summariseDeck(parsed.rules) : null,
    cards: parsed.rules?.cards.map((card) => ({ id: card.id, label: card.label, needsValue: needsValueChoice(card) })) ?? []
  };
}

/** A deck OWNED BY this campaign, for the editor. A global, library or another campaign's deck is not found. */
export async function getOwnDeck(userId: string, campaignId: string, deckId: string): Promise<AdminDeck | null> {
  await requireManage(userId, campaignId, { write: false });
  return getDeckCore({ kind: 'campaign', campaignId }, deckId);
}

/** An empty deck: it parses (with a "no cards" warning) so it can be saved and filled in. */
const EMPTY_RULES = { version: 1, cards: [], success: { rules: [], otherwise: 'failure' }, outcomes: [] };
const slugOf = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'deck';

/** Inserts a deck row for an owner. Campaign decks are scope 'campaign' (creator recorded); personal ones are scope 'personal' with a library key. */
async function insertDeck(client: pg.PoolClient, owner: DeckOwner, actorUserId: string, name: string, description: string, rules: unknown): Promise<string> {
  // A random suffix keeps keys unique even for two decks created in the same millisecond.
  const suffix = crypto.randomBytes(5).toString('hex');
  const key = owner.kind === 'personal' ? `library:${owner.userId}:deck:${slugOf(name)}:${suffix}` : `deck:${slugOf(name)}:${suffix}`;
  const campaignId = owner.kind === 'campaign' ? owner.campaignId : null;
  const created = await client.query<{ id: string }>(
    `INSERT INTO content_definitions (content_key, content_type, name, description, source_kind, owner_user_id, activation_type, requires_concentration, stack_behavior, metadata_json, scope, campaign_id)
     VALUES ($1, 'deck', $2, $3, 'homebrew', $4, 'passive', false, 'stack', '{}'::jsonb, $5, $6) RETURNING id`,
    [key, name, description, actorUserId, owner.kind, campaignId]);
  // deck_definitions.campaign_id is now an unread mirror of content_definitions.campaign_id (migration 050); keep it in step.
  await client.query('INSERT INTO deck_definitions (content_id, rules_json, campaign_id) VALUES ($1, $2::jsonb, $3)', [created.rows[0].id, JSON.stringify(rules), campaignId]);
  return created.rows[0].id;
}

async function createDeckCore(owner: DeckOwner, userId: string, nameIn: string, descriptionIn: string): Promise<string> {
  const name = nameIn.trim();
  if (!name) throw new DeckError('bad_input', 'Name is required.');
  if (name.length > 120) throw new DeckError('bad_input', 'Name is too long (120 characters at most).');
  return withTransaction((client) => insertDeck(client, owner, userId, name, descriptionIn.trim().slice(0, 5000), EMPTY_RULES));
}

export async function createDeck(input: { userId: string; campaignId: string; name: string; description: string }): Promise<string> {
  await requireManage(input.userId, input.campaignId, { write: true });
  const id = await createDeckCore({ kind: 'campaign', campaignId: input.campaignId }, input.userId, input.name, input.description);
  invalidateReferenceData('createDeck');
  return id;
}

/** Copies a GLOBAL deck into the campaign as an editable deck named "X (copy)". Library and other campaigns' decks can't be copied. */
export async function copyDeckToCampaign(input: { userId: string; campaignId: string; sourceId: string }): Promise<string> {
  await requireManage(input.userId, input.campaignId, { write: true });
  if (!isUuid(input.sourceId)) throw new DeckError('bad_input', 'Pick a deck to copy.');
  const source = (await query<any>(
    `SELECT c.name, c.description, d.rules_json FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id
     WHERE c.id = $1 AND c.content_type = 'deck' AND c.scope = 'global' AND NOT c.is_archived`, [input.sourceId])).rows[0];
  if (!source) throw new DeckError('not_found', 'Deck not found.');
  const name = `${source.name} (copy)`.slice(0, 120);
  const id = await withTransaction((client) => insertDeck(client, { kind: 'campaign', campaignId: input.campaignId }, input.userId, name, source.description, source.rules_json));
  invalidateReferenceData('copyDeck');
  return id;
}

export type SaveDeckResult = { ok: true; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Validates and saves an owned deck's name, description and rules JSON. Nothing is written when there is any error:
 * bad JSON, a parser error, or a condition key this deck may not name (see the condition check below). Warnings save.
 */
async function saveDeckCore(owner: DeckOwner, input: { id: string; name: string; description: string; rulesText: string }): Promise<SaveDeckResult> {
  if (!isUuid(input.id)) return { ok: false, errors: ['Deck not found.'] };
  const errors: string[] = [];
  const name = input.name.trim();
  if (!name) errors.push('Name is required.');
  if (name.length > 120) errors.push('Name is too long (120 characters at most).');
  if (input.rulesText.length > DECK_RULES_MAX_CHARS) errors.push(`The rules JSON is too long (${DECK_RULES_MAX_CHARS} characters at most).`);
  let json: unknown = null;
  if (!errors.length) {
    try { json = JSON.parse(input.rulesText); } catch (error) { errors.push(`The rules are not valid JSON: ${(error as Error).message}`); }
  }
  let warnings: string[] = [];
  if (!errors.length) {
    const parsed = parseDeckRules(json);
    errors.push(...parsed.errors);
    warnings = parsed.warnings;
    if (parsed.rules) {
      const keys = collectConditionKeys(parsed.rules);
      if (keys.length) {
        // Which conditions a deck may name (library plan, unit F; the pure rule is canReference in $lib/library/rules):
        //   personal deck: global, plus the author's own conditions;
        //   campaign deck: global, plus this campaign's own conditions, plus conditions of libraries enabled in it.
        // Archived ones are refused here (a new reference); at draw time they become a DM task.
        const owners = owner.kind === 'personal' ? [owner.userId] : (await loadCampaignLibraries({ query }, owner.campaignId)).enabledOwnerIds;
        const campaignId = owner.kind === 'campaign' ? owner.campaignId : null;
        const found = await query<{ content_key: string }>(
          `SELECT c.content_key FROM content_definitions c
           WHERE c.content_key = ANY($1::text[]) AND c.content_type = 'condition' AND NOT c.is_archived
             AND ((c.scope = 'global' AND c.owner_user_id IS NULL)
               OR (c.scope = 'campaign' AND c.campaign_id = $2::uuid)
               OR (c.scope = 'personal' AND c.owner_user_id = ANY($3::uuid[])))`, [keys, campaignId, owners]);
        const ok = new Set(found.rows.map((row) => row.content_key));
        for (const key of keys) if (!ok.has(key)) errors.push(`Condition "${key}" does not exist, is archived, or is not available to this deck (global conditions, ${owner.kind === 'personal' ? 'and your own library' : "this campaign's own, and libraries enabled here"}).`);
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  const saved = await withTransaction(async (client) => {
    // The ownership check is part of the write: only a deck with this ownership matches.
    const owned = await client.query(`SELECT 1 FROM content_definitions c WHERE c.id = $1 AND c.content_type = 'deck' AND ${ownedBy(owner, '$2')} FOR UPDATE`, [input.id, ownerId(owner)]);
    if (!owned.rows.length) return false;
    await client.query(`UPDATE content_definitions SET name = $2, description = $3, updated_at = now() WHERE id = $1 AND content_type = 'deck'`,
      [input.id, name, input.description.trim().slice(0, 5000)]);
    await client.query('UPDATE deck_definitions SET rules_json = $2::jsonb, updated_at = now() WHERE content_id = $1', [input.id, JSON.stringify(json)]);
    return true;
  });
  if (!saved) return { ok: false, errors: ['Deck not found.'] };
  invalidateReferenceData('updateDeck');
  return { ok: true, warnings };
}

export async function updateDeck(input: { userId: string; campaignId: string; id: string; name: string; description: string; rulesText: string }): Promise<SaveDeckResult> {
  await requireManage(input.userId, input.campaignId, { write: true });
  return saveDeckCore({ kind: 'campaign', campaignId: input.campaignId }, input);
}

/** Archive or restore an owned deck (never deleted: draws reference it). */
async function toggleArchivedCore(owner: DeckOwner, id: string, archived: boolean): Promise<boolean> {
  if (!isUuid(id)) return false;
  const result = await query(
    `UPDATE content_definitions c SET is_archived = $3, updated_at = now() FROM deck_definitions d
     WHERE c.id = $1 AND d.content_id = c.id AND c.content_type = 'deck' AND ${ownedBy(owner, '$2')}`, [id, ownerId(owner), archived]);
  invalidateReferenceData('toggleDeckArchived');
  return (result.rowCount ?? 0) > 0;
}

export async function toggleDeckArchived(input: { userId: string; campaignId: string; id: string; archived: boolean }): Promise<boolean> {
  await requireManage(input.userId, input.campaignId, { write: true });
  return toggleArchivedCore({ kind: 'campaign', campaignId: input.campaignId }, input.id, input.archived);
}

const TEST_PARTY: Record<string, string> = { a: 'Aria', b: 'Brom', c: 'Cass' };

/** "Test draw": plans a chosen card of an owned deck against a fake three-member party. Nothing is written. */
async function dryRunCore(owner: DeckOwner, input: { id: string; cardId: string; success: 'auto' | 'success' | 'failure'; value?: number | null }): Promise<{ lines: string[]; error?: string }> {
  if (!isUuid(input.id)) return { lines: [], error: 'Deck not found.' };
  const result = await query<any>(
    `SELECT d.rules_json FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id
     WHERE c.id = $1 AND c.content_type = 'deck' AND ${ownedBy(owner, '$2')}`, [input.id, ownerId(owner)]);
  if (!result.rows.length) return { lines: [], error: 'Deck not found.' };
  const parsed = parseDeckRules(result.rows[0].rules_json);
  if (!parsed.rules) return { lines: [], error: `The saved rules are invalid: ${parsed.errors[0]}` };
  const card = parsed.rules.cards.find((entry) => entry.id === input.cardId);
  if (!card) return { lines: [], error: 'Pick a card.' };
  const success = input.success === 'auto' ? cardSuccess(parsed.rules, card) : input.success === 'success';
  const choose = needsValueChoice(card);
  const value = choose ? (card.valueOptions?.includes(input.value ?? NaN) ? input.value! : card.valueOptions![0]) : null;
  const plan = planDraw({ rules: parsed.rules, card, success, chosenValue: value, drawerId: 'a', partyIds: ['a', 'b', 'c'] });
  return {
    lines: [
      `${card.label}: ${success ? 'success' : 'failure'}${choose ? ` (counted as ${value})` : ''}`,
      `Outcome: ${plan.outcome.name}. ${plan.outcome.text}`,
      ...plan.outcome.rolls.map((roll) => `Roll ${roll.name}: ${roll.text}`),
      ...plan.lines.map((line) => describeLine(line, TEST_PARTY) + (line.detail ? ` (${line.detail})` : '')),
      ...plan.tasks.map((task) => `Waiting on the DM: ${task.text}`)
    ]
  };
}

export async function dryRunDraw(input: { userId: string; campaignId: string; id: string; cardId: string; success: 'auto' | 'success' | 'failure'; value?: number | null }): Promise<{ lines: string[]; error?: string }> {
  await requireManage(input.userId, input.campaignId, { write: false });
  return dryRunCore({ kind: 'campaign', campaignId: input.campaignId }, input);
}

// ---------------------------------------------------------------- personal decks (the /library/decks page)
// A personal deck belongs to its author's library. It is REFERENCED, never copied, wherever a DM enables it (so an
// edit reaches every campaign using it), and it can only be enabled where the DM has switched that library on.

export type PersonalDeckRow = { id: string; name: string; archived: boolean; cardCount: number | null; invalid: boolean; enabledIn: number };

/** The user's own library decks (archived ones included, so they can be restored). */
export async function listPersonalDecks(userId: string): Promise<PersonalDeckRow[]> {
  await requirePersonal(userId, { write: false });
  const result = await query<any>(
    `SELECT c.id, c.name, c.is_archived, d.rules_json,
            (SELECT count(*) FROM campaign_decks cd WHERE cd.deck_content_id = c.id AND cd.is_enabled)::int AS enabled_in
     FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id
     WHERE c.content_type = 'deck' AND ${ownedBy({ kind: 'personal', userId }, '$1')} ORDER BY c.is_archived, c.name`, [userId]);
  return result.rows.map((row) => {
    const parsed = parseDeckRules(row.rules_json);
    return { id: row.id, name: row.name, archived: row.is_archived, cardCount: parsed.rules?.cards.length ?? null, invalid: !parsed.rules, enabledIn: row.enabled_in };
  });
}

/** One of the user's own library decks for the editor; anyone else's is not found. */
export async function getPersonalDeck(userId: string, deckId: string): Promise<AdminDeck | null> {
  await requirePersonal(userId, { write: false });
  return getDeckCore({ kind: 'personal', userId }, deckId);
}

export async function createPersonalDeck(input: { userId: string; name: string; description: string }): Promise<string> {
  await requirePersonal(input.userId, { write: true });
  const id = await createDeckCore({ kind: 'personal', userId: input.userId }, input.userId, input.name, input.description);
  invalidateReferenceData('createPersonalDeck');
  return id;
}

export async function updatePersonalDeck(input: { userId: string; id: string; name: string; description: string; rulesText: string }): Promise<SaveDeckResult> {
  await requirePersonal(input.userId, { write: true });
  return saveDeckCore({ kind: 'personal', userId: input.userId }, input);
}

/** Archiving only takes a deck out of use, so it needs ownership, not mechanics rights. Campaigns that enabled it stop drawing. */
export async function togglePersonalDeckArchived(input: { userId: string; id: string; archived: boolean }): Promise<boolean> {
  return toggleArchivedCore({ kind: 'personal', userId: input.userId }, input.id, input.archived);
}

export async function dryRunPersonalDraw(input: { userId: string; id: string; cardId: string; success: 'auto' | 'success' | 'failure'; value?: number | null }): Promise<{ lines: string[]; error?: string }> {
  return dryRunCore({ kind: 'personal', userId: input.userId }, input);
}

/**
 * "Save to my library": makes a personal copy of one of the campaign's OWN decks, so it can be enabled in other
 * campaigns (by reference). An explicit DM action, never done automatically. The campaign deck is left as it is and
 * the two are independent afterwards. Needs canManage here and mechanics rights.
 */
export async function saveDeckToLibrary(input: { userId: string; campaignId: string; deckId: string }): Promise<string> {
  await requireManage(input.userId, input.campaignId, { write: true });
  await requirePersonal(input.userId, { write: true });
  if (!isUuid(input.deckId)) throw new DeckError('bad_input', 'Pick a deck.');
  const source = (await query<any>(
    `SELECT c.name, c.description, d.rules_json FROM content_definitions c JOIN deck_definitions d ON d.content_id = c.id
     WHERE c.id = $1 AND c.content_type = 'deck' AND ${ownedBy({ kind: 'campaign', campaignId: input.campaignId }, '$2')}`, [input.deckId, input.campaignId])).rows[0];
  if (!source) throw new DeckError('not_found', 'Deck not found.');
  const id = await withTransaction((client) => insertDeck(client, { kind: 'personal', userId: input.userId }, input.userId, source.name, source.description, source.rules_json));
  invalidateReferenceData('saveDeckToLibrary');
  return id;
}
