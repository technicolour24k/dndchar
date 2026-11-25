import { sessions, broadcast, filterTokenForPlayer } from '$vtt/store.js';

// A deck draw (or its undo) changes a character's HP in the database. VTT token HP is session-authoritative
// (never synced from the sheet), so the same delta is also nudged onto the character's live PC tokens in the
// campaign's room. Pure of the database; the live store and broadcast are injectable for tests.
type Deps = { sessions: Map<string, any>; broadcast: (sessionId: string, build: (recipient: any) => unknown) => void };
const live: Deps = { sessions, broadcast };

/**
 * (`onlyTokenId` limits it to one token, for undo.) Adds `delta` to `stats.hp` of each live `pc` token of the character in that room, clamped to 0..maxHp
 * (no upper clamp when the token has no numeric maxHp). Tells the room with the same `token:stat:update`
 * payload token.js sends (a hidden token or an unrevealed map reaches the GM only).
 * Returns the delta actually applied per token id (empty when none moved). A positive delta never pulls a token that is already over max down.
 */
export function nudgeCharacterTokenHp(roomCode: string, characterId: string, delta: number, deps: Deps = live, onlyTokenId?: string): Record<string, number> {
  const session = deps.sessions.get(roomCode);
  const applied: Record<string, number> = {};
  if (!session || !Number.isFinite(delta) || !delta) return applied;
  const mapHidden = session.map && !session.map.revealed;
  for (const token of Object.values<any>(session.tokens ?? {})) {
    if (token.type !== 'pc' || token.characterId !== characterId) continue;
    if (onlyTokenId && token.id !== onlyTokenId) continue;
    const current = Number(token.stats?.hp) || 0;
    const max = Number(token.stats?.maxHp);
    const capped = Math.min(Number.isFinite(max) && max > 0 ? max : Infinity, current + delta);
    const next = Math.max(0, delta > 0 ? Math.max(current, capped) : capped);
    if (next === current) continue;
    applied[token.id] = next - current;
    token.stats = token.stats || {};
    token.stats.hp = next;
    deps.broadcast(session.id, (recipient: any) => {
      if (recipient.role !== 'gm' && (token.hidden || mapHidden)) return null;
      return { type: 'token:stat:update', tokenId: token.id, stat: 'hp', value: next, token: recipient.role === 'gm' ? token : filterTokenForPlayer(token) };
    });
  }
  return applied;
}
