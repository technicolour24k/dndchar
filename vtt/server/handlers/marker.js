// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { shouldPlayerSeeMarker } from '../store.js';

// Phase 2 Section 4 - cone/cube/sphere alongside the original circle. The
// server stays geometry-agnostic (per store.js's shape-agnostic
// shouldPlayerSeeMarker) - it just trusts shape from a fixed allowlist and
// passes the shape-specific fields through opaquely, exactly like radiusFt
// already did for circles.
const ALLOWED_SHAPES = new Set(['circle', 'cone', 'cube', 'sphere']);

function canEditMarker(meta, marker) {
  if (meta.role === 'gm') return true;
  return marker.ownerId === meta.playerId;
}

// Same shape as broadcastToken in token.js: GM always gets the raw marker,
// players only if they own it or the GM has flipped visibleToAll - and, as of
// Phase 10, not at all while the map itself is unrevealed (same hard-gate
// rule as tokens: nothing map-related reaches players until the GM reveals).
function broadcastMarker(context, session, sessionId, eventType, marker, extra = {}) {
  const mapHidden = session.map && !session.map.revealed;
  context.broadcast(sessionId, (recipient) => {
    if (recipient.role === 'gm') return { type: eventType, ...extra, marker };
    if (mapHidden || !shouldPlayerSeeMarker(marker, recipient.playerId)) return null;
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

      const shape = ALLOWED_SHAPES.has(input.shape) ? input.shape : 'circle';

      const marker = {
        id: input.id,
        ownerId,
        shape,
        x: input.x,
        y: input.y,
        radiusFt: Number(input.radiusFt) || 0, // circle/sphere
        angleDeg: Number(input.angleDeg) || 0, // cone/cube facing
        lengthFt: Number(input.lengthFt) || 0, // cone length / cube depth
        widthFt: Number(input.widthFt) || 0, // cube width
        coneAngleDeg: Number(input.coneAngleDeg) || 60, // 5e-standard default; per-spell override
        color: input.color || '#ff5252',
        label: input.label || '',
        visibleToAll: false, // starts private to owner+GM; GM shares it via the toggle below
      };

      session.markers[marker.id] = marker;
      broadcastMarker(context, session, meta.sessionId, 'marker:add', marker);
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
      const mapHidden = session.map && !session.map.revealed;

      context.broadcast(meta.sessionId, (recipient) => {
        if (recipient.role === 'gm') {
          return { type: 'marker:visibility:toggle', markerId: marker.id, visibleToAll: marker.visibleToAll };
        }
        const isOwner = marker.ownerId === recipient.playerId;
        if (isOwner) return null; // the owner could already see it either way
        if (mapHidden) return null; // nothing to gain/lose - player has no markers while unrevealed
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
