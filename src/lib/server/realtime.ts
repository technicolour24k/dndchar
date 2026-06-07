type RealtimeEvent = 'character:updated' | 'resource:changed' | 'encounter:updated' | 'effect:expired' | 'round:advanced';

export function emitRealtimeEvent(event: RealtimeEvent, payload: Record<string, unknown>) {
  // Adapter-node can be extended with a Socket.IO server later. For this milestone,
  // writes persist to PostgreSQL first and this function centralizes the emit point.
  console.info(`[realtime:${event}]`, payload);
}
