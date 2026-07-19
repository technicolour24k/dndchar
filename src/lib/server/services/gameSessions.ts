import { query } from '$lib/server/db';
import { sessions, broadcast } from '$vtt/store.js';

export type GameSession = { id: string; name: string; isActive: boolean; ownerUserId: string; createdAt: string };
export type SessionNote = { id: string; gameSessionId: string; userId: string; displayName: string; message: string; createdAt: string };

export async function createGameSession(userId: string, name: string): Promise<string> {
  const result = await query<{ id: string }>(
    'INSERT INTO game_sessions (owner_user_id, name) VALUES ($1,$2) RETURNING id',
    [userId, name.trim() || 'New Session']
  );
  return result.rows[0].id;
}

export async function endGameSession(userId: string, gameSessionId: string): Promise<void> {
  await query('UPDATE game_sessions SET is_active=false, updated_at=now() WHERE id=$1 AND owner_user_id=$2', [gameSessionId, userId]);
}

// Any signed-in user may join, not just the owner - matches this app's existing
// "no ownership locks" posture. Only used by /sessions and /sessions/[id]'s own
// join actions now - the character sheet no longer calls this directly, it
// derives an active game session from room membership instead (see
// getActiveGameSessionForUser below).
export async function joinGameSession(userId: string, gameSessionId: string): Promise<void> {
  const result = await query(
    'UPDATE users SET active_game_session_id = $1 WHERE id = $2 AND EXISTS (SELECT 1 FROM game_sessions WHERE id = $1 AND is_active = true)',
    [gameSessionId, userId]
  );
  if (!result.rowCount) throw new Error('Session not found or not active.');
}

// Pure room-derivation, no fallback - "is there a live game session happening
// right now in the room this user is currently connected to." This is what
// the character sheet must use (both to display state and to decide where a
// posted note goes) - it must never show or post to a session the user
// happens to have joined ages ago through a completely different flow (see
// getActiveGameSessionForUser below for where that's still wanted).
export async function getRoomGameSessionId(userId: string): Promise<string | null> {
  const result = await query<{ active_vtt_session_id: string | null }>(
    'SELECT active_vtt_session_id FROM users WHERE id = $1',
    [userId]
  );
  const roomId = result.rows[0]?.active_vtt_session_id;
  return roomId ? (sessions.get(roomId)?.gameSessionId ?? null) : null;
}

// Fallback chain, deliberately: prefer the room-derived session above, fall
// back to the older explicit users.active_game_session_id column (set by
// joinGameSession). Scoped narrowly to SessionNotesModal's own "have I joined
// THIS specific session" check (GET /vtt/api/game-sessions/[id]) - posting to
// a named Game Session from that modal without being connected to any VTT
// room at all (reviewing/posting after the fact) still needs this fallback.
// The character sheet's own view of "what's active in my room" intentionally
// does NOT use this - see getRoomGameSessionId.
export async function getActiveGameSessionForUser(userId: string): Promise<string | null> {
  const roomDerived = await getRoomGameSessionId(userId);
  if (roomDerived) return roomDerived;
  const result = await query<{ active_game_session_id: string | null }>(
    'SELECT active_game_session_id FROM users WHERE id = $1',
    [userId]
  );
  return result.rows[0]?.active_game_session_id ?? null;
}

export async function getGameSession(id: string): Promise<GameSession | null> {
  const result = await query<any>('SELECT id, name, is_active, owner_user_id, created_at FROM game_sessions WHERE id = $1', [id]);
  const row = result.rows[0];
  return row ? { id: row.id, name: row.name, isActive: row.is_active, ownerUserId: row.owner_user_id, createdAt: row.created_at } : null;
}

// "Been part of" is inferred (owns it, or has posted a note in it) rather than
// tracked via a separate participants table - simpler, at the cost of "joined
// but never posted" not showing up. Acceptable for a running log, not a roster.
export async function listGameSessionsForUser(userId: string): Promise<GameSession[]> {
  const result = await query<any>(
    `SELECT DISTINCT s.id, s.name, s.is_active, s.owner_user_id, s.created_at
     FROM game_sessions s
     LEFT JOIN game_session_notes n ON n.game_session_id = s.id AND n.user_id = $1
     WHERE s.owner_user_id = $1 OR n.user_id = $1
     ORDER BY s.created_at DESC`,
    [userId]
  );
  return result.rows.map((row) => ({ id: row.id, name: row.name, isActive: row.is_active, ownerUserId: row.owner_user_id, createdAt: row.created_at }));
}

// Pushes live to any VTT room whose in-memory session.gameSessionId matches -
// same scan-for-a-match pattern as combatLog.ts's logCombatEvent, since a note
// can be posted from a surface (character sheet, /sessions page) that has no
// specific room in scope.
function broadcastToMatchingSession(gameSessionId: string, note: SessionNote) {
  for (const session of sessions.values()) {
    if (session.gameSessionId === gameSessionId) {
      broadcast(session.id, () => ({ type: 'game_session:note', note }));
    }
  }
}

export async function logSessionNote(gameSessionId: string, userId: string, message: string): Promise<SessionNote> {
  const result = await query<any>(
    `INSERT INTO game_session_notes (game_session_id, user_id, message)
     SELECT $1, $2, $3 FROM game_sessions WHERE id = $1 AND is_active = true
     RETURNING id, game_session_id, user_id, message, created_at`,
    [gameSessionId, userId, message]
  );
  if (!result.rowCount) throw new Error('Session not found or not active.');
  const row = result.rows[0];
  const userRow = await query<{ display_name: string }>('SELECT display_name FROM users WHERE id = $1', [userId]);
  const note: SessionNote = {
    id: row.id,
    gameSessionId: row.game_session_id,
    userId: row.user_id,
    displayName: userRow.rows[0]?.display_name || 'Someone',
    message: row.message,
    createdAt: row.created_at
  };
  broadcastToMatchingSession(gameSessionId, note);
  return note;
}

export async function listSessionNotes(gameSessionId: string, afterId?: string): Promise<SessionNote[]> {
  const params: unknown[] = [gameSessionId];
  let afterClause = '';
  if (afterId) {
    afterClause = 'AND n.created_at > (SELECT created_at FROM game_session_notes WHERE id = $2)';
    params.push(afterId);
  }
  const result = await query<any>(
    `SELECT n.id, n.game_session_id, n.user_id, n.message, n.created_at, u.display_name
     FROM game_session_notes n JOIN users u ON u.id = n.user_id
     WHERE n.game_session_id = $1 ${afterClause}
     ORDER BY n.created_at ASC`,
    params
  );
  return result.rows.map((row) => ({
    id: row.id, gameSessionId: row.game_session_id, userId: row.user_id,
    displayName: row.display_name, message: row.message, createdAt: row.created_at
  }));
}
