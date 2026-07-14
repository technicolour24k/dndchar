// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { shouldPlayerSeeMarker } from '../store.js';

function canEditMarker(meta, marker) {
  if (meta.role === 'gm') return true;
  return marker.ownerId === meta.playerId;
}

// Same shape as broadcastToken in token.js: GM always gets the raw marker,
// players only if they own it or the GM has flipped visibleToAll.
function broadcastMarker(context, sessionId, eventType, marker, extra = {}) {
  context.broadcast(sessionId, (recipient) => {
    if (recipient.role === 'gm') return { type: eventType, ...extra, marker };
    if (!shouldPlayerSeeMarker(marker, recipient.playerId)) return null;
    return { type: eventType, ...extra, marker };
  });
}

function handleMarkerEvent(meta, msg, context) {
  const session = context.sessions.get(meta.sessionId);
  if (!session) return;

  switch (msg.type) {
    case 'marker:add': {
      const input = msg.marker;
      if (!input || !input.id) return;

      // Players can only ever place markers owned by themselves - the client
      // suggests ownerId but the server is authoritative, same trust
      // boundary as canEditToken. GM-placed markers have no owner.
      const ownerId = meta.role === 'gm' ? (input.ownerId ?? null) : meta.playerId;

      const marker = {
        id: input.id,
        ownerId,
        shape: 'circle', // only shape implemented for now; kept explicit for future shapes
        x: input.x,
        y: input.y,
        radiusFt: Number(input.radiusFt) || 0,
        color: input.color || '#ff5252',
        label: input.label || '',
        visibleToAll: false, // starts private to owner+GM; GM shares it via the toggle below
      };

      session.markers[marker.id] = marker;
      broadcastMarker(context, meta.sessionId, 'marker:add', marker);
      break;
    }

    case 'marker:remove': {
      const marker = session.markers[msg.markerId];
      if (!marker || !canEditMarker(meta, marker)) return;
      delete session.markers[msg.markerId];
      context.broadcast(meta.sessionId, (recipient) => {
        if (recipient.role === 'gm') return { type: 'marker:remove', markerId: msg.markerId };
        if (!shouldPlayerSeeMarker(marker, recipient.playerId)) return null; // never knew it existed
        return { type: 'marker:remove', markerId: msg.markerId };
      });
      break;
    }

    case 'marker:visibility:toggle': {
      // GM-only control, per the brief ("a toggle for All Players as a GM control").
      if (meta.role !== 'gm') return;
      const marker = session.markers[msg.markerId];
      if (!marker) return;
      marker.visibleToAll = !marker.visibleToAll;

      context.broadcast(meta.sessionId, (recipient) => {
        if (recipient.role === 'gm') {
          return { type: 'marker:visibility:toggle', markerId: marker.id, visibleToAll: marker.visibleToAll };
        }
        const isOwner = marker.ownerId === recipient.playerId;
        if (isOwner) return null; // the owner could already see it either way
        // Non-owners are gaining or losing visibility of a marker they may
        // never have received before - that's an add/remove, not an update.
        return marker.visibleToAll
          ? { type: 'marker:add', marker }
          : { type: 'marker:remove', markerId: marker.id };
      });
      break;
    }

    default:
      break;
  }
}

export default handleMarkerEvent;
