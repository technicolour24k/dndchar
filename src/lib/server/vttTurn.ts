import { sessions, broadcast } from '$vtt/store.js';

// Sheet Next Turn / Next Round / New Battle also restore the character's movement on any live VTT
// token (the VTT's own Reset buttons do it over the socket). Pure of the database; the live store
// and broadcast are injectable so it is tested with fake sessions.
type Deps = { sessions: Map<string, any>; broadcast: (sessionId: string, build: (recipient: any) => unknown) => void };
const live: Deps = { sessions, broadcast };

// For each live session with tokens of this character that track movement (a numeric
// speedRemainingFt), sets it back to speedFt and tells the room, with the same filter the VTT's
// own resetAll uses: a player never hears about a hidden token or an unrevealed map. Returns the
// number of tokens reset.
export function resetLiveTokenMovement(characterId: string, deps: Deps = live): number {
  let total = 0;
  for (const session of deps.sessions.values()) {
    const updates: any[] = [];
    for (const token of Object.values<any>(session.tokens ?? {})) {
      if (token.characterId !== characterId || typeof token.speedRemainingFt !== 'number') continue;
      token.speedRemainingFt = token.speedFt || 0;
      updates.push(token);
    }
    if (!updates.length) continue;
    total += updates.length;
    const mapHidden = session.map && !session.map.revealed;
    deps.broadcast(session.id, (recipient: any) => {
      const visible = recipient.role === 'gm' ? updates : updates.filter((token) => !token.hidden && !mapHidden);
      if (!visible.length) return null;
      return { type: 'token:move:resetAll', updates: visible.map((token) => ({ tokenId: token.id, speedRemainingFt: token.speedRemainingFt })) };
    });
  }
  return total;
}

// The trimmed display copy of a turn view that tokens carry (token.turn). One implementation, shared
// with the browser, so the character route, the VTT client and the token handler's sanitizer agree.
export { trimTurnView } from '../../../static/vtt-app/shared/actionEconomy.js';
