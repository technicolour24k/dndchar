import { query } from '$lib/server/db';
import { sessions, broadcast } from '$vtt/store.js';

export type CombatLogEntry = {
  id: string;
  encounterId: string;
  message: string;
  details: Record<string, unknown>;
  createdAt: string;
};

function toEntry(row: any): CombatLogEntry {
  return {
    id: row.id,
    encounterId: row.encounter_id,
    message: row.message,
    details: row.details ?? {},
    createdAt: row.created_at
  };
}

// Pushes live to whichever VTT session (if any) currently has this encounter
// active - a single choke point so every write path (VTT attack resolution via
// the internal /vtt/api/log endpoint, and sheet-originated HP-delta edits)
// gets this for free instead of each caller re-implementing it. Unlike
// rollLog.ts's logRoll, the caller here only knows the encounter id, not a
// specific room, so this has to scan for a match rather than broadcast directly.
function broadcastToMatchingSession(encounterId: string, message: string, details: Record<string, unknown>) {
  for (const session of sessions.values()) {
    if (session.encounterId === encounterId) {
      broadcast(session.id, () => ({ type: 'combat:log', message, details }));
    }
  }
}

export async function logCombatEvent(
  encounterId: string,
  message: string,
  details: Record<string, unknown> = {}
): Promise<CombatLogEntry> {
  const result = await query<any>(
    'INSERT INTO combat_log_entries (encounter_id, message, details) VALUES ($1,$2,$3) RETURNING *',
    [encounterId, message, JSON.stringify(details)]
  );
  broadcastToMatchingSession(encounterId, message, details);
  return toEntry(result.rows[0]);
}

// afterId narrows to entries created after the given entry's timestamp - used
// by the character sheet's polling panel to fetch only what it hasn't seen yet.
export async function listCombatLogEntries(encounterId: string, afterId?: string): Promise<CombatLogEntry[]> {
  if (afterId) {
    const result = await query<any>(
      `SELECT * FROM combat_log_entries
       WHERE encounter_id = $1 AND created_at > (SELECT created_at FROM combat_log_entries WHERE id = $2)
       ORDER BY created_at ASC`,
      [encounterId, afterId]
    );
    return result.rows.map(toEntry);
  }
  const result = await query<any>(
    'SELECT * FROM combat_log_entries WHERE encounter_id = $1 ORDER BY created_at ASC',
    [encounterId]
  );
  return result.rows.map(toEntry);
}
