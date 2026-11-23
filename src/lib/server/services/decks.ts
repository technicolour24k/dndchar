import crypto from 'node:crypto';
import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { cachedReference } from '$lib/server/cache/referenceData';
import { getCampaignAccess, getCharacterAccess, isUuid } from '$lib/server/services/access';
import { applyCharacterEffect } from '$lib/server/services/effects';
import { primeSheetAc } from '$lib/server/vttTokenAc';
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
     FROM campaign_decks cd JOIN content_definitions c ON c.id = cd.deck_content_id
     WHERE cd.campaign_id = $1 AND ($2::boolean OR (cd.is_enabled AND NOT c.is_archived)) ORDER BY c.name`,
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
  const enabled = await query('SELECT 1 FROM campaign_decks cd JOIN content_definitions c ON c.id = cd.deck_content_id WHERE cd.campaign_id = $1 AND cd.deck_content_id = $2 AND cd.is_enabled AND NOT c.is_archived', [campaignId, deckId]);
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

/** Applies one condition line through the normal effect path. A missing/archived condition becomes a DM task. */
async function applyConditionLine(client: pg.PoolClient, draw: any, line: PlannedLine, names: Record<string, string>): Promise<{ result: Partial<DrawResultLine>; task?: string }> {
  const container = await client.query<{ id: string; name: string }>(
    `SELECT id, name FROM content_definitions WHERE content_key = $1 AND content_type = 'condition' AND is_archived = false AND owner_user_id IS NULL`, [line.conditionKey]);
  const who = names[line.characterId] ?? 'Someone';
  if (!container.rows.length) {
    const label = (line.conditionKey ?? 'condition').replace(/^condition:/, '').replace(/_/g, ' ');
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
  const access = await getCampaignAccess({ query }, input.userId, input.campaignId);
  if (!access?.canManage) throw new DeckError('forbidden', 'Only the DM can change the campaign\'s decks.');
  const deck = await query<{ is_archived: boolean }>(`SELECT is_archived FROM content_definitions WHERE id = $1 AND content_type = 'deck'`, [input.deckId]);
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
