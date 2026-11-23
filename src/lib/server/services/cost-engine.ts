import crypto from 'node:crypto';
import type pg from 'pg';
import { applySpellAccessCost, asTurnLine, defaultCostFor, effectiveCost, parseCostJson, planCost, withCategory } from '$lib/rules/cost';
import { actionPoolMaxima, followupCount, readTurnRow, resolveTurnPool, spellFollowupClass, type TurnRead } from '$lib/rules/actionEconomy';
import type { ActionEconomyProfile, FollowupClass, TurnLogEntry } from '$lib/types/actionEconomy';
import type { Activation, CostAvailability, CostEntry, CostShortfall, PlannedCost } from '$lib/types/cost';
import { loadPoolMaxima, POOL_ROW_PREFIX, writeLedger } from '$lib/server/services/resource-pools';
import { characterProfile, loadTurnContext, lockTurnRow, writeTurnRow } from '$lib/server/services/turn-state';

// LOCK ORDER. Every writer that touches several of a character's resource rows takes them in this
// one order, so two of them can never deadlock:
//   character_turn_state -> spell slots -> content counters -> inventory counters -> inventory item (quantity) -> character_resources
// (character_resources holds pools, hp and hit dice; character_turn_state holds per-turn action
// spending and is ALWAYS FIRST: a cast holds it while its on_cast steps lock slots, counters and
// pools, so anything that takes it later could deadlock against that). payActivationCost below,
// restCharacter, newBattle, advanceCharacterTurn and advanceCharacterRound (catalogue.ts, via
// lockTurnState), reviewOverride's undo and refillCharacterPools (resource-pools.ts) all follow it.
// A new multi-source writer must too.
// Decks (services/decks.ts) lock the affected `characters` rows in ascending id, then their hp / temp_hp
// character_resources rows: the whole-sheet Save's order (characters row, then resources). They take no turn state.
// Known, pre-existing inversion: the action engine's coin step locks resources (hp) before the characters row (coin)
// inside one cast, the opposite of the sheet Save and of decks. A true collision is theoretical; Postgres aborts
// one of the two transactions cleanly (deadlock error) rather than hanging.
//
// The one way anything is paid at activation (sheet and VTT). Reads the activated Container's
// cost_json (or the content type's default, which copies the old procedural behaviour exactly),
// plans it against what the character has, and either pays it with a ledger row per line or throws
// CostShortfallError with nothing spent. With a CostOverride (DM approval, the DM's own go-ahead, or a
// no-DM self override) a short activation pays what it can instead (each line min(available, amount),
// nothing below 0) and every ledger row records the override. Who may use an override is decided
// BEFORE the transaction, in vttCostApproval.ts.

export class CostShortfallError extends Error {
  shortfalls: CostShortfall[];
  constructor(shortfalls: CostShortfall[]) {
    super("It doesn't look like you've got the capacity to do that.");
    this.name = 'CostShortfallError';
    this.shortfalls = shortfalls;
  }
}

// Thrown when a 'require' follow-up choice finds no follow-up to spend. Nothing has been paid.
export class FollowupGoneError extends Error {
  constructor() {
    super('That free repeat is no longer available.');
    this.name = 'FollowupGoneError';
  }
}

// How a short activation is let through. Built by vttCostApproval.ts after it has checked who is allowed.
export type CostOverride = {
  kind: 'dm_approved' | 'dm_self' | 'self_override';
  approvedByUserId?: string | null;
  approvalRequestId?: string | null;
  roomId?: string | null;
  // "Spend nothing": let it through and pay no line (rows are still written, delta 0).
  waive?: boolean;
  // Called once if the override actually let a short activation through (not when it was affordable).
  onUsed?: (used: { kind: CostOverride['kind']; label: string; shortfalls: CostShortfall[]; waived: boolean }) => void;
};

export type PaidLine = {
  label: string;
  pool: string;
  delta: number;
  before: number;
  after: number;
  // Set on a spell slot line, so the VTT can mirror exactly which slot was spent.
  slot?: { slotType: 'standard' | 'pact'; slotLevel: number };
  // Set on a spell echo (a free follow-up): it resolves at the spell's base level whatever was cast before.
  castAtLevel?: number;
};

export type LoadedCost = {
  entries: CostEntry[];
  // The Container being activated (null for a freeform inventory item).
  contentId: string | null;
  label: string;
  // Where this activation's own counters live.
  counters: { scope: 'instance' | 'inventory'; id: string } | null;
  inventoryId: string | null; // the item whose quantity an 'item' line spends
  // Follow-ups (Extra Attack, echoes): the attack type this activation consumes and grants, and
  // whether paying its action grants them. Null for activations that have none.
  followup?: { cls: FollowupClass; grants: boolean } | null;
};

function parseExplicit(raw: unknown): CostEntry[] | null {
  const parsed = parseCostJson(raw, { stored: true });
  if (parsed.errors.length) throw new Error(`This has an invalid cost: ${parsed.errors[0]}`);
  return parsed.entries;
}

export async function loadActivationCost(client: pg.PoolClient, characterId: string, activation: Activation): Promise<LoadedCost> {
  if (activation.kind === 'spell') {
    const row = (await client.query(
      `SELECT c.id, c.name, c.cost_json, s.spell_level, s.casting_time FROM character_content_instances i
       JOIN content_definitions c ON c.id = i.content_id JOIN spell_definitions s ON s.content_id = c.id
       WHERE i.id = $1 AND i.character_id = $2`, [activation.instanceId, characterId])).rows[0];
    if (!row) throw new Error('Character content not found.');
    const entries = withCategory(effectiveCost(parseExplicit(row.cost_json), defaultCostFor({ contentType: 'spell', spellLevel: row.spell_level, castingTime: row.casting_time })), 'spell');
    return { entries, contentId: row.id, label: row.name, counters: { scope: 'instance', id: activation.instanceId }, inventoryId: null, followup: spellFollowup(row.spell_level, entries) };
  }
  if (activation.kind === 'spell_access') {
    const row = (await client.query(
      `SELECT access.access_type, access.resource_definition_id, access.resource_cost_expression, d.resource_key,
         c.id, c.name, c.cost_json, s.spell_level, s.casting_time
       FROM content_spell_access access
       JOIN content_definitions c ON c.id = access.spell_content_id JOIN spell_definitions s ON s.content_id = c.id
       LEFT JOIN content_resource_definitions d ON d.id = access.resource_definition_id
       WHERE access.id = $1`, [activation.spellAccessId])).rows[0];
    if (!row) throw new Error('Granted Spell is unavailable.');
    const charged = row.access_type === 'charges' || row.access_type === 'limited_free';
    if (charged && !row.resource_definition_id) throw new Error('This Spell access has no charge resource.');
    const base = effectiveCost(parseExplicit(row.cost_json), defaultCostFor({ contentType: 'spell', spellLevel: row.spell_level, castingTime: row.casting_time }));
    const entries = withCategory(applySpellAccessCost(base, { accessType: row.access_type, resourceKey: row.resource_key, resourceCostExpression: row.resource_cost_expression }), 'spell');
    return { entries, contentId: row.id, label: row.name, counters: { scope: 'inventory', id: activation.inventoryItemId }, inventoryId: null, followup: spellFollowup(row.spell_level, entries) };
  }
  if (activation.kind === 'item') {
    const item = (await client.query(
      `SELECT i.name, i.source_content_id, c.cost_json FROM character_inventory_items i
       LEFT JOIN content_definitions c ON c.id = i.source_content_id WHERE i.id = $1 AND i.character_id = $2`,
      [activation.inventoryId, characterId])).rows[0];
    if (!item) throw new Error('Inventory item is unavailable.');
    const common = { counters: { scope: 'inventory' as const, id: activation.inventoryId }, inventoryId: activation.inventoryId };
    if (!item.source_content_id) {
      // Freeform item: using it consumes one, as ever.
      return { entries: [{ pool: 'item', amount: 1 }, ...defaultCostFor({ contentType: 'item', isItemUse: true, hasSpendItemStep: true, includeUseAction: true })], contentId: null, label: item.name, ...common };
    }
    const spendStep = await client.query(
      `SELECT 1 FROM content_action_links link JOIN action_steps step ON step.container_id = link.action_container_id
       WHERE link.content_id = $1 AND link.trigger_type = 'on_use' AND step.step_type = 'spend_item' LIMIT 1`, [item.source_content_id]);
    let entries = withCategory(effectiveCost(parseExplicit(item.cost_json), defaultCostFor({ contentType: 'item', isItemUse: true, hasSpendItemStep: Boolean(spendStep.rowCount), includeUseAction: true })), 'general');
    // An explicit 'item' line plus an on_use spend_item step would pay the quantity twice: the step
    // keeps paying (existing behaviour), so the engine drops its own item line.
    if (spendStep.rowCount) entries = entries.filter((entry) => entry.pool !== 'item');
    return { entries, contentId: item.source_content_id, label: item.name, ...common };
  }
  if (activation.kind === 'weapon_attack') {
    const timing = activation.timing ?? 'action';
    let label = (activation.label ?? '').trim().slice(0, 80) || 'Attack';
    if (activation.inventoryId) {
      const item = (await client.query('SELECT name FROM character_inventory_items WHERE id = $1 AND character_id = $2', [activation.inventoryId, characterId])).rows[0];
      if (!item) throw new Error('Inventory item is unavailable.');
      label = `${item.name} attack`;
    }
    // Every weapon attack is a melee-type attack for follow-ups until ranged attacks exist (rollAttack is melee-only).
    // Extra Attack is part of the Attack action, so only an Action-timed attack grants or uses follow-ups
    // (an off-hand or opportunity attack neither earns one nor burns one).
    return { entries: defaultCostFor({ contentType: 'item', activationKind: 'weapon_attack', weaponTiming: timing }), contentId: null, label, counters: null, inventoryId: null, followup: timing === 'action' ? { cls: 'melee', grants: true } : null };
  }
  if (activation.kind === 'dash') {
    if (!Number.isInteger(activation.count) || activation.count < 1 || activation.count > 9) throw new Error('A dash is 1 to 9 actions.');
    return { entries: defaultCostFor({ contentType: 'item', activationKind: 'dash', dashCount: activation.count }), contentId: null, label: 'Dash', counters: null, inventoryId: null, followup: null };
  }
  // content: a feat, class feature, or a spell's "Use Actions" button. Free unless a DM set a cost.
  const row = (await client.query(
    `SELECT c.id, c.name, c.cost_json FROM character_content_instances i JOIN content_definitions c ON c.id = i.content_id
     WHERE i.id = $1 AND i.character_id = $2`, [activation.instanceId, characterId])).rows[0];
  if (!row) throw new Error('Character content not found.');
  return { entries: withCategory(effectiveCost(parseExplicit(row.cost_json), []), 'general'), contentId: row.id, label: row.name, counters: { scope: 'instance', id: activation.instanceId }, inventoryId: null, followup: null };
}

// A spell consumes and grants follow-ups of its own type: levelled spells and cantrips are separate
// (a doublecast of one doesn't echo the other).
// Only an Action-timed spell earns or spends an echo (matching weapon attacks: a bonus-action or
// reaction spell neither earns nor burns one).
function spellFollowup(spellLevel: number | null | undefined, entries: CostEntry[]): { cls: FollowupClass; grants: boolean } | null {
  const cls = spellFollowupClass(spellLevel, entries.map((e) => asTurnLine(e)).find((line) => line !== null)?.timing);
  return cls ? { cls, grants: true } : null;
}

// Pool names that are already ledger pool values; anything else is a character pool key ('pool:<key>').
const OVERRIDE_UNPAID_POOLS = new Set(['spell_slot', 'charges', 'item']);

function planChoices(activation: Activation, loaded: LoadedCost) {
  const slot = activation.kind === 'spell' || activation.kind === 'spell_access' ? { slotType: activation.slotType, slotLevel: activation.slotLevel } : {};
  // A waiting follow-up is spent only when the caller chose to: weapon attacks default to 'use',
  // spells to 'skip' (an echo is a deliberate choice, never a silent downgrade of a normal cast).
  const defaultChoice = activation.kind === 'weapon_attack' ? 'use' : 'skip';
  const choice = (activation.kind === 'spell' || activation.kind === 'spell_access' || activation.kind === 'weapon_attack' ? activation.followup : undefined) ?? defaultChoice;
  return loaded.followup && (choice === 'use' || choice === 'require') ? { ...slot, followupClass: loaded.followup.cls } : slot;
}

// The per-turn state an activation with a turn line works against (action economy). Read on the
// transaction's own client; the row is locked only when paying, and always LAST (lock order).
type TurnLock = {
  profile: ActionEconomyProfile;
  maxima: ReturnType<typeof actionPoolMaxima>;
  read: TurnRead;
  // What paying this activation's action grants (Extra Attack and friends), from the live modifiers.
  grant: { count: number; labels: string[] } | null;
};

type Locked = {
  availability: CostAvailability;
  counterRows: Map<string, { id: string; current: number }>;
  poolMax: Map<string, number>;
  turn: TurnLock | null;
};

// Locks only the sources the cost touches, in a fixed order (slots, counters, item, pools), so two
// concurrent activations can't deadlock.
async function lockSources(client: pg.PoolClient, characterId: string, loaded: LoadedCost, lock: boolean, turn: TurnLock | null): Promise<Locked> {
  const suffix = lock ? ' FOR UPDATE' : '';
  const availability: CostAvailability = { slots: [], counters: [], itemQuantity: null, pools: {} };
  const counterRows = new Map<string, { id: string; current: number }>();
  const poolMax = new Map<string, number>();
  const pools = loaded.entries.filter((e) => !['spell_slot', 'charges', 'item'].includes(e.pool) && !asTurnLine(e));

  if (loaded.entries.some((e) => e.pool === 'spell_slot')) {
    const slots = await client.query(
      `SELECT slot_type, slot_level, current_slots FROM character_spell_slots WHERE character_id = $1 ORDER BY slot_type, slot_level${suffix}`, [characterId]);
    availability.slots = slots.rows.map((r: any) => ({ type: r.slot_type, level: r.slot_level, current: r.current_slots }));
  }
  if (loaded.counters && loaded.entries.some((e) => e.pool === 'charges')) {
    const table = loaded.counters.scope === 'instance' ? 'character_content_resources' : 'character_inventory_resources';
    const owner = loaded.counters.scope === 'instance' ? 'character_content_id' : 'inventory_item_id';
    const rows = await client.query(
      `SELECT r.id, d.resource_key, d.label, r.current_value FROM ${table} r JOIN content_resource_definitions d ON d.id = r.resource_definition_id
       WHERE r.${owner} = $1 ORDER BY d.resource_key${lock ? ' FOR UPDATE OF r' : ''}`, [loaded.counters.id]);
    for (const r of rows.rows as any[]) {
      availability.counters.push({ key: r.resource_key, label: r.label, current: r.current_value });
      counterRows.set(r.resource_key, { id: r.id, current: r.current_value });
    }
  }
  if (loaded.inventoryId && loaded.entries.some((e) => e.pool === 'item')) {
    const row = await client.query(`SELECT quantity FROM character_inventory_items WHERE id = $1 AND character_id = $2${suffix}`, [loaded.inventoryId, characterId]);
    availability.itemQuantity = row.rows[0]?.quantity ?? 0;
  }
  if (pools.length) {
    const { definitions, maxima } = await loadPoolMaxima(characterId, false, client);
    const wanted = new Set(pools.map((e) => e.pool));
    for (const definition of definitions) {
      if (!wanted.has(definition.key)) continue;
      const max = maxima[definition.key].max;
      poolMax.set(definition.key, max);
      const rowKey = `${POOL_ROW_PREFIX}${definition.key}`;
      if (lock) {
        // Lazy row (no row means full), then lock it.
        await client.query(
          `INSERT INTO character_resources (character_id, resource_key, label, current_value, max_value, sort_order)
           VALUES ($1,$2,$3,$4,$4,200) ON CONFLICT (character_id, resource_key) DO NOTHING`, [characterId, rowKey, definition.label, max]);
      }
      const row = await client.query(`SELECT current_value FROM character_resources WHERE character_id = $1 AND resource_key = $2${suffix}`, [characterId, rowKey]);
      const stored = row.rows[0]?.current_value;
      availability.pools[definition.key] = { label: definition.label, current: stored === undefined ? max : Math.max(0, Math.min(max, stored)) };
    }
  }
  if (turn) {
    availability.turn = {
      profile: turn.profile.key,
      pools: Object.fromEntries(turn.profile.pools.map((def) => [def.key, { label: def.label, current: Math.max(0, turn.maxima[def.key].max - (turn.read.spent[def.key] ?? 0)) }])),
      followups: Object.fromEntries(Object.entries(turn.read.followups).map(([cls, state]) => [cls, state.remaining]))
    };
  }
  return { availability, counterRows, poolMax, turn };
}

// The per-turn state, or null when no turn line of this cost draws from a pool (a Free or movement
// line, or none: nothing loaded, nothing locked). With `lock` it takes the turn row, and it must be
// called BEFORE lockSources: the turn row is the first lock in the order (see the top of this file).
async function loadTurn(client: pg.PoolClient, characterId: string, loaded: LoadedCost, lock: boolean): Promise<TurnLock | null> {
  if (!(await turnLinePays(client, characterId, loaded.entries))) return null;
  const context = await loadTurnContext(characterId, client);
  const maxima = actionPoolMaxima(context.profile, context.sources, context.ctx);
  const read = lock
    ? await lockTurnRow(client, characterId, context.profile.key)
    : readTurnRow((await client.query('SELECT profile_key, turn_seq, spent_json, followups_json, log_json FROM character_turn_state WHERE character_id = $1', [characterId])).rows[0], context.profile.key);
  const grants = loaded.followup?.grants ? followupCount(loaded.followup.cls, context.sources, context.ctx) : null;
  return { profile: context.profile, maxima, read, grant: grants && grants.count > 0 ? { count: grants.count, labels: grants.lines.map((l) => l.label) } : null };
}

// True when some turn line of this cost would actually draw from a pool under the character's profile
// (a Free or movement line, or no turn line at all, never does).
async function turnLinePays(client: pg.PoolClient, characterId: string, entries: CostEntry[]): Promise<boolean> {
  const lines = entries.map((e) => asTurnLine(e)).filter((line) => line !== null);
  if (!lines.length) return false;
  const profile = await characterProfile(client, characterId);
  return lines.some((line) => resolveTurnPool(profile, line) !== null);
}

// Read-only: what this activation would cost and what's short. Nothing is locked or written.
export async function previewActivationCost(client: pg.PoolClient, characterId: string, activation: Activation): Promise<PlannedCost & { label: string }> {
  const loaded = await loadActivationCost(client, characterId, activation);
  const { availability } = await lockSources(client, characterId, loaded, false, await loadTurn(client, characterId, loaded, false));
  return { ...planCost(loaded.entries, availability, planChoices(activation, loaded)), label: loaded.label };
}

// Pays the activation's cost, or throws CostShortfallError with nothing spent (the caller's
// transaction rolls back). One ledger row per paid line, sharing an activation_id.
export async function payActivationCost(
  client: pg.PoolClient, characterId: string, activation: Activation, options: { actorUserId: string; override?: CostOverride | null }
): Promise<PaidLine[]> {
  const loaded = await loadActivationCost(client, characterId, activation);
  const required = 'followup' in activation && activation.followup === 'require';
  // Turn lines only: free unless one actually draws from the profile's pools. Takes no locks otherwise.
  // A required follow-up can't exist here (nothing draws from a pool), so it fails rather than pass as free.
  if (!loaded.entries.some((e) => !asTurnLine(e)) && !(await turnLinePays(client, characterId, loaded.entries))) {
    if (required) throw new FollowupGoneError();
    return [];
  }
  const { availability, counterRows, poolMax, turn } = await lockSources(client, characterId, loaded, true, await loadTurn(client, characterId, loaded, true));
  const plan = planCost(loaded.entries, availability, planChoices(activation, loaded));
  // 'require' is "free repeat or nothing": checked before the shortfall and override logic so it can
  // never fall through to paying the action (or asking the DM to let a short cost through).
  if (required && !plan.lines.some((line) => line.payFrom?.pool === 'followup')) throw new FollowupGoneError();
  const override = plan.shortfalls.length ? options.override ?? null : null;
  if (plan.shortfalls.length && !override) throw new CostShortfallError(plan.shortfalls);
  const waived = Boolean(override?.waive);

  const activationId = crypto.randomUUID();
  const paid: PaidLine[] = [];
  const running = new Map<string, number>(); // value left per source, so repeated lines chain
  // short = how much of this line couldn't be paid (0 on a normal spend). Under an override every row
  // carries the override kind, so a review sees the whole activation.
  const ledger = (pool: string, poolDetail: Record<string, unknown>, label: string, n: number, before: number | null, short = 0) => writeLedger(client, {
    characterId, pool, poolDetail: waived ? { ...poolDetail, waived: true } : poolDetail, label, delta: n === 0 ? 0 : -n, before,
    after: before === null ? null : before - n, shortfall: short, reason: 'cost', sourceContentId: loaded.contentId,
    sourceLabel: loaded.label, activationId, actorUserId: options.actorUserId,
    ...(override ? { overrideKind: override.kind, approvedByUserId: override.approvedByUserId ?? null, approvalRequestId: override.approvalRequestId ?? null, roomId: override.roomId ?? null } : {})
  });

  // This turn's changes, written once at the end (the turn row is last in the lock order).
  const spent: Record<string, number> = turn ? { ...turn.read.spent } : {};
  const followups = turn ? structuredClone(turn.read.followups) : {};
  const log: TurnLogEntry[] = turn ? [...turn.read.log] : [];
  let paidTurnFromPool = false;
  let turnChanged = false;
  const logTurn = (pool: string, label: string, amount: number, via: string) => {
    log.push({ pool, label, amount, via, source: loaded.label, at: new Date().toISOString() });
    turnChanged = true;
  };

  for (const line of plan.lines) {
    if (line.displayOnly) continue;
    const from = line.payFrom;
    // What this line actually pays: all of it normally; under an override the part it can afford.
    const n = waived ? 0 : override ? Math.min(line.needed, line.available) : line.needed;
    const short = override ? Math.max(0, line.needed - (waived ? line.available : n)) : 0;
    if (!from) {
      // A line with no source at all (no slot of that level, unknown counter or pool): nothing to pay.
      if (override) await ledger(OVERRIDE_UNPAID_POOLS.has(line.entry.pool) ? line.entry.pool : `pool:${line.entry.pool}`, { unpaid: true }, line.label, 0, null, short);
      continue;
    }
    if (from.pool === 'spell_slot') {
      const id = `slot:${from.slotType}:${from.slotLevel}`;
      const before = running.get(id) ?? availability.slots.find((s) => s.type === from.slotType && s.level === from.slotLevel)!.current;
      await client.query(`UPDATE character_spell_slots SET current_slots = current_slots - $4 WHERE character_id = $1 AND slot_type = $2 AND slot_level = $3`,
        [characterId, from.slotType, from.slotLevel, n]);
      running.set(id, before - n);
      await ledger('spell_slot', { slotType: from.slotType, slotLevel: from.slotLevel }, line.label, n, before, short);
      if (n > 0) paid.push({ label: line.label, pool: 'spell_slot', delta: -n, before, after: before - n, slot: { slotType: from.slotType, slotLevel: from.slotLevel } });
    } else if (from.pool === 'charges') {
      const row = counterRows.get(from.key)!;
      const id = `charges:${from.key}`;
      const before = running.get(id) ?? row.current;
      const table = loaded.counters!.scope === 'instance' ? 'character_content_resources' : 'character_inventory_resources';
      await client.query(`UPDATE ${table} SET current_value = current_value - $2 WHERE id = $1`, [row.id, n]);
      running.set(id, before - n);
      await ledger('charges', { resourceId: row.id, resourceKey: from.key, scope: loaded.counters!.scope }, line.label, n, before, short);
      if (n > 0) paid.push({ label: line.label, pool: 'charges', delta: -n, before, after: before - n });
    } else if (from.pool === 'item') {
      const before = running.get('item') ?? availability.itemQuantity ?? 0;
      await client.query(`UPDATE character_inventory_items SET quantity = quantity - $2 WHERE id = $1`, [loaded.inventoryId, n]);
      running.set('item', before - n);
      await ledger('item', { inventoryId: loaded.inventoryId }, line.label, n, before, short);
      if (n > 0) paid.push({ label: line.label, pool: 'item', delta: -n, before, after: before - n });
    } else if (from.pool === 'turn' && turn) {
      // A normal turn spend is NOT ledgered (it resets every turn): the turn row's own log is the
      // audit trail. Under an override it IS, so the DM review sees the whole activation.
      const before = Math.max(0, turn.maxima[from.key].max - (spent[from.key] ?? 0));
      if (n > 0) spent[from.key] = (spent[from.key] ?? 0) + n;
      paidTurnFromPool = true;
      logTurn(from.key, loaded.label, n, override ? 'override' : 'pool');
      // The row also says which follow-ups this action earned, so an undo can take them back.
      const earns = loaded.followup?.grants && turn.grant ? { grantedCls: loaded.followup.cls, grantedCount: turn.grant.count } : {};
      if (override) await ledger(`turn:${from.key}`, { profile: turn.profile.key, turnSeq: turn.read.turnSeq, ...earns }, line.label, n, before, short);
      if (n > 0) paid.push({ label: line.label, pool: `turn:${from.key}`, delta: -n, before, after: before - n });
    } else if (from.pool === 'followup' && turn) {
      // A follow-up waives the action (a weapon repeat) or the whole cost (a spell echo: the plan has
      // no other line, and castAtLevel says which level it resolves at).
      const state = followups[from.cls];
      const before = state?.remaining ?? 0;
      if (state) state.remaining = Math.max(0, state.remaining - 1);
      logTurn(`followup:${from.cls}`, `${loaded.label} (${turn.read.followups[from.cls]?.sources[0] ?? 'Extra Attack'})`, 1, 'followup');
      paid.push({ label: line.label, pool: 'followup', delta: -1, before, after: Math.max(0, before - 1), ...(plan.castAtLevel !== undefined ? { castAtLevel: plan.castAtLevel } : {}) });
    } else if (from.pool === 'pool') {
      const id = `pool:${from.key}`;
      const before = running.get(id) ?? availability.pools[from.key].current;
      await client.query(
        `UPDATE character_resources SET current_value = $3, max_value = $4, label = $5 WHERE character_id = $1 AND resource_key = $2`,
        [characterId, `${POOL_ROW_PREFIX}${from.key}`, before - n, poolMax.get(from.key) ?? 0, line.label]);
      running.set(id, before - n);
      await ledger(id, {}, line.label, n, before, short);
      if (n > 0) paid.push({ label: line.label, pool: id, delta: -n, before, after: before - n });
    }
  }
  // Paying an action from a pool grants this activation's follow-ups (they accumulate), never when
  // the action was itself covered by one.
  if (turn && paidTurnFromPool && loaded.followup?.grants && turn.grant) {
    const cls = loaded.followup.cls;
    const existing = followups[cls];
    followups[cls] = {
      remaining: (existing?.remaining ?? 0) + turn.grant.count,
      sources: [...new Set([...(existing?.sources ?? []), ...turn.grant.labels])],
      perAction: turn.grant.count
    };
    turnChanged = true;
  }
  if (turn && turnChanged) await writeTurnRow(client, characterId, turn.profile.key, { turnSeq: turn.read.turnSeq, spent, followups, log });
  override?.onUsed?.({ kind: override.kind, label: loaded.label, shortfalls: plan.shortfalls, waived });
  return paid;
}
