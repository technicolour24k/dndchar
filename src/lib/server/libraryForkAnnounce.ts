import { publish } from '$vtt/store.js';
import { invalidateReferenceData } from '$lib/server/cache/referenceData';
import { emitRealtimeEvent } from '$lib/server/realtime';
import type { ForkSummary } from '$lib/server/services/libraryFork';

// What happens AFTER a fork has committed (plans/dndchar/homebrew-library, unit G, step 6). The database change is
// already done, so none of this may throw or fail the request: the room and open sheets just catch up.
//  - the 60 s picker scope cache and the catalogue index are cleared, so the copies are offered straight away;
//  - every character whose sheet changed is told to re-sync (open sheets, VTT tokens);
//  - the campaign's room is pinged so open campaign pages can refetch (the ping carries no content).

export function announceFork(summaries: ForkSummary | ForkSummary[], roomCode: string | null | undefined): void {
  const list = Array.isArray(summaries) ? summaries : [summaries];
  try {
    invalidateReferenceData('library:fork');
    const characterIds = new Set(list.flatMap((summary) => summary.touchedCharacterIds));
    for (const characterId of characterIds) emitRealtimeEvent('resource:changed', { characterId });
    if (roomCode) publish(`room:${roomCode}`, { type: 'library:forked' });
  } catch (error) {
    console.error('[library fork] announce failed (the fork itself committed)', error);
  }
}
