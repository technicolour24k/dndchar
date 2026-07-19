import { query } from '$lib/server/db';
import { broadcast } from '$vtt/store.js';

export type RollLogEntry = {
  id: string;
  sessionId: string;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
};

function toEntry(row: any): RollLogEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    message: row.message,
    details: row.details ?? {},
    createdAt: row.created_at
  };
}

// Unlike combatLog.ts's logCombatEvent, the caller here already knows the
// exact VTT room id (it's whatever the character joined via "Join Session"),
// so this can broadcast directly instead of scanning sessions for a match.
export async function logRoll(
  sessionId: string,
  message: string,
  details: Record<string, unknown> = {}
): Promise<RollLogEntry> {
  const result = await query<any>(
    'INSERT INTO roll_log_entries (session_id, message, details) VALUES ($1,$2,$3) RETURNING *',
    [sessionId, message, JSON.stringify(details)]
  );
  const entry = toEntry(result.rows[0]);
  broadcast(sessionId, () => ({ type: 'roll:log', message, details }));
  return entry;
}

// "Which room is this character currently reporting rolls into" - set by the
// character sheet's "Join Session" action, read by its roll-logging action.
export async function getCharacterVttSessionId(characterId: string): Promise<string | null> {
  const result = await query<{ active_vtt_session_id: string | null }>(
    'SELECT active_vtt_session_id FROM characters WHERE id = $1',
    [characterId]
  );
  return result.rows[0]?.active_vtt_session_id ?? null;
}

export async function listRollLogEntries(sessionId: string, afterId?: string): Promise<RollLogEntry[]> {
  if (afterId) {
    const result = await query<any>(
      `SELECT * FROM roll_log_entries
       WHERE session_id = $1 AND created_at > (SELECT created_at FROM roll_log_entries WHERE id = $2)
       ORDER BY created_at ASC`,
      [sessionId, afterId]
    );
    return result.rows.map(toEntry);
  }
  const result = await query<any>(
    'SELECT * FROM roll_log_entries WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId]
  );
  return result.rows.map(toEntry);
}
