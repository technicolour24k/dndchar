import { broadcast, publish } from '$vtt/store.js';

// Live-update pings for the overworld. They carry NO map content: the watch topics are
// unauthenticated, so a payload here is only ever "something changed, re-fetch". The re-fetch goes
// through the normal gated page load.

/**
 * Someone changed a map, pin or route. Just type + mapId: no user id either, because anyone can
 * subscribe to this topic. Viewers simply re-fetch whoever made the change.
 */
export function notifyOverworldChanged(campaignId: string, mapId: string): void {
  publish(`overworld:${campaignId}`, { type: 'overworld:changed', mapId });
}

/**
 * A map was just shared with the party. Goes to everyone at the campaign's VTT table, which is
 * authenticated (join tickets), so it may carry the map name. A no-op if nobody is at the table.
 */
export function notifyMapGranted(roomCode: string, mapId: string, mapName: string): void {
  broadcast(roomCode, () => ({ type: 'overworld:granted', mapId, mapName }));
}
