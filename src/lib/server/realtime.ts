import { sessions, broadcast } from '$vtt/store.js';

type RealtimeEvent = 'character:updated' | 'resource:changed' | 'encounter:updated' | 'effect:expired' | 'round:advanced';

// db-traffic-reduction Phase 6: every character write path (characters/[id]/
// +page.server.ts's actions, including Phase 4's setEquipped/
// removeInventoryItem) already calls this with a characterId, unchanged - the
// signature was kept exactly so no caller needed editing.
//
// When a payload carries a characterId, scan every live VTT room for a token
// pointing at that character and push a lightweight "go re-sync yourself"
// notification, so static/vtt-app/main.js's syncOwnedCharacterTokens (saves/
// actions/preparedSpells only - see that function's own comment for the
// hp/maxHp/ac/speedFt/vision clobber rule) can run on push instead of its old
// 30s poll. This is a plain scan (not a topic-based publish - see vtt/server/
// store.js's Phase 5 watchersByTopic) because the recipients here are real
// VTT session participants (GM + players), not a sheet's narrow "watch"
// subscription - broadcast() already reaches them via socketsBySession.
export function emitRealtimeEvent(event: RealtimeEvent, payload: Record<string, unknown>) {
  console.info(`[realtime:${event}]`, payload);

  const characterId = payload.characterId;
  if (typeof characterId !== 'string') return;

  for (const session of sessions.values()) {
    const hasMatchingToken = Object.values(session.tokens).some((token: any) => token.characterId === characterId);
    if (!hasMatchingToken) continue;
    broadcast(session.id, () => ({ type: 'character:changed', characterId }));
  }
}
