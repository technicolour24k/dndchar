import type pg from 'pg';
import { query, withTransaction } from '$lib/server/db';
import { assertCanEditCharacter, type Queryable } from '$lib/server/services/access';
import { loadModifierContext } from '$lib/server/services/resource-pools';
import { actionPoolMaxima, buildTurnView, followupCount, profileFor, readTurnRow, type TurnRead, type TurnRow } from '$lib/rules/actionEconomy';
import { FOLLOWUP_CLASSES, type ActionEconomyProfile, type FollowupClass, type ProfileKey, type TurnLogEntry, type TurnView } from '$lib/types/actionEconomy';
import type { PoolMaxContext } from '$lib/rules/cost';
import type { ActiveCharacterEffect } from '$lib/types/character';

// Per-turn action pools (action economy, plans/dndchar/action-economy). What a character has SPENT
// this turn lives in character_turn_state, one lazy row per character (no row = nothing spent).
// It is not in character_resources on purpose: the whole-sheet Save wipes non-pool rows there and
// snapshots copy that table. LOCK ORDER: the turn row is always taken FIRST, before every resource
// row (see cost-engine.ts).

export const TURN_LOG_CAP = 30;

// Locks the turn row without reading anything from it. Every multi-resource writer that also resets
// the turn (rests, New Battle, Next Turn, Next Round) calls this FIRST in its transaction: the turn
// row is the first lock in the global order (see cost-engine.ts), because a cast holds it while its
// on_cast steps lock slots, counters and pools.
export async function lockTurnState(client: pg.PoolClient, characterId: string): Promise<void> {
  await lockTurnRow(client, characterId, (await characterProfile(client, characterId)).key);
}

// The profile a character plays by: its live campaign's, else 5e.
export async function characterProfile(db: Queryable, characterId: string): Promise<ActionEconomyProfile> {
  const result = await db.query(
    `SELECT cp.action_economy FROM characters c
     LEFT JOIN campaigns cp ON cp.id = c.campaign_id AND NOT cp.is_archived WHERE c.id = $1`, [characterId]);
  return profileFor(result.rows[0]?.action_economy);
}

export type TurnContext = { profile: ActionEconomyProfile; sources: ActiveCharacterEffect[]; ctx: PoolMaxContext };

// Everything needed to compute maxima. With `db` (a transaction client) it reads sequentially on
// that client and never takes another pool connection.
export async function loadTurnContext(characterId: string, db?: Queryable): Promise<TurnContext> {
  const q = db ?? { query };
  const profile = await characterProfile(q, characterId);
  const { sources, ctx } = await loadModifierContext(characterId, db);
  return { profile, sources, ctx };
}

const ROW_COLUMNS = 'profile_key, turn_seq, spent_json, followups_json, log_json';

// The per-class follow-up count for the view, from the live modifiers.
function liveFollowups(context: TurnContext) {
  return Object.fromEntries(FOLLOWUP_CLASSES.map((cls) => [cls, { count: followupCount(cls, context.sources, context.ctx).count }])) as Partial<Record<FollowupClass, { count: number }>>;
}

function viewFor(context: TurnContext, read: TurnRead): TurnView {
  return buildTurnView(context.profile, read, actionPoolMaxima(context.profile, context.sources, context.ctx), liveFollowups(context));
}

// The sheet's turn view. Read-only, no lock.
export async function getTurnView(db: Queryable, characterId: string, context?: TurnContext): Promise<TurnView> {
  const loaded = context ?? (await loadTurnContext(characterId, db));
  const row = await db.query(`SELECT ${ROW_COLUMNS} FROM character_turn_state WHERE character_id = $1`, [characterId]);
  return viewFor(loaded, readTurnRow(row.rows[0] as TurnRow | undefined, loaded.profile.key));
}

// Lazy row, then lock it. A row written under another profile reads as fresh (readTurnRow).
export async function lockTurnRow(client: pg.PoolClient, characterId: string, profileKey: ProfileKey): Promise<TurnRead> {
  await client.query(`INSERT INTO character_turn_state (character_id, profile_key) VALUES ($1, $2) ON CONFLICT (character_id) DO NOTHING`, [characterId, profileKey]);
  const row = await client.query(`SELECT ${ROW_COLUMNS} FROM character_turn_state WHERE character_id = $1 FOR UPDATE`, [characterId]);
  return readTurnRow(row.rows[0] as TurnRow, profileKey);
}

// Writes the whole row under the current profile. The log keeps the newest TURN_LOG_CAP entries.
export async function writeTurnRow(client: pg.PoolClient, characterId: string, profileKey: ProfileKey, state: TurnRead): Promise<void> {
  const log = state.log.slice(-TURN_LOG_CAP);
  await client.query(
    `INSERT INTO character_turn_state (character_id, profile_key, turn_seq, spent_json, followups_json, log_json, updated_at)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, now())
     ON CONFLICT (character_id) DO UPDATE SET profile_key = EXCLUDED.profile_key, turn_seq = EXCLUDED.turn_seq,
       spent_json = EXCLUDED.spent_json, followups_json = EXCLUDED.followups_json, log_json = EXCLUDED.log_json, updated_at = now()`,
    [characterId, profileKey, state.turnSeq, JSON.stringify(state.spent), JSON.stringify(state.followups), JSON.stringify(log)]);
}

// A fresh turn: spent, follow-ups and log cleared, turn_seq + 1, current profile. Call it LAST in a
// transaction (lock order). Used by Next Turn, Next Round, New Battle and rests.
// `note` (the VTT's manual Reset buttons) leaves one line in the fresh turn's log saying who reset it.
export async function resetTurnState(client: pg.PoolClient, characterId: string, note?: string): Promise<void> {
  const profile = await characterProfile(client, characterId);
  const log: TurnLogEntry[] = note ? [{ pool: 'turn', label: note.slice(0, 80), amount: 0, via: 'manual', source: 'Manual', at: new Date().toISOString() }] : [];
  await client.query(
    `INSERT INTO character_turn_state (character_id, profile_key, turn_seq, log_json) VALUES ($1, $2, 1, $3::jsonb)
     ON CONFLICT (character_id) DO UPDATE SET profile_key = EXCLUDED.profile_key, turn_seq = character_turn_state.turn_seq + 1,
       spent_json = '{}'::jsonb, followups_json = '{}'::jsonb, log_json = EXCLUDED.log_json, updated_at = now()`,
    [characterId, profile.key, JSON.stringify(log)]);
}

// Manual +/- on a pool (bookkeeping, like the resource pools' own +/-): delta changes what is LEFT,
// so -1 spends one. Spent stays within 0..max. Needs edit access.
export async function adjustTurnPool(userId: string, characterId: string, key: string, delta: number): Promise<TurnView> {
  if (!Number.isInteger(delta) || delta === 0) throw new Error('Pick a whole number to change the pool by.');
  await assertCanEditCharacter({ query }, userId, characterId);
  return withTransaction(async (client) => {
    await assertCanEditCharacter(client, userId, characterId);
    const context = await loadTurnContext(characterId, client);
    const def = context.profile.pools.find((pool) => pool.key === key);
    if (!def) throw new Error(`This campaign has no ${key} action pool.`);
    const max = actionPoolMaxima(context.profile, context.sources, context.ctx)[key].max;
    const state = await lockTurnRow(client, characterId, context.profile.key);
    const before = Math.min(max, state.spent[key] ?? 0);
    const after = Math.max(0, Math.min(max, before - delta));
    if (after !== before) {
      const spent = { ...state.spent };
      if (after === 0) delete spent[key]; else spent[key] = after;
      const entry: TurnLogEntry = { pool: key, label: `${def.label} adjusted by hand`, amount: Math.abs(before - after), via: 'manual', source: 'Manual', at: new Date().toISOString() };
      state.spent = spent;
      state.log = [...state.log, entry];
      await writeTurnRow(client, characterId, context.profile.key, state);
    }
    return viewFor(context, state);
  });
}
