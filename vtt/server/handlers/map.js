// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { filterSessionForRole } from '../store.js';

// map:set's payload is always a complete object literal rebuilt fresh by the
// Map Settings form (imageUrl/dimensions/gridSizePx/brightness/music) - it
// never carries `revealed` (Phase 10 deliberately keeps Reveal/Hide out of
// that form, see the brief's Section 2). So `revealed` has to be threaded
// through by hand here: reset to false only when the map image itself
// actually changes (a genuinely new map should require a fresh reveal),
// otherwise preserve whatever reveal state already existed so incidental
// settings tweaks (brightness, grid size) on the *same* map don't silently
// re-hide it from players mid-session.
function handleMapSet(meta, msg, session, context) {
  if (!msg.map) return;
  const isNewImage = !session.map || session.map.imageUrl !== msg.map.imageUrl;
  session.map = { ...msg.map, revealed: isNewImage ? false : (session.map?.revealed ?? false) };

  context.broadcast(meta.sessionId, (recipient) => {
    if (recipient.role === 'gm' || session.map.revealed) {
      return { type: 'map:set', map: session.map };
    }
    // Unrevealed: players get only the flag, never the image/dimensions -
    // same shape filterSessionForRole already produces for join/reconnect.
    return { type: 'map:set', map: { revealed: false } };
  });
}

// map:reveal flips the map's visibility and pushes everyone a fresh
// per-recipient session snapshot in one message (map + tokens + markers, all
// re-filtered) rather than just the map object - a reveal/hide is exactly the
// moment a player's token/marker view needs to jump from nothing to
// everything (or back), not just the map layer. Deliberately its own
// message type (map:revealed) rather than reusing state:full verbatim -
// state:full's handler also re-fetches combat-log/roll-log/session-notes
// backlogs, which would be wasted round-trips on every single toggle click.
function handleMapReveal(meta, session, context) {
  if (!session.map) return; // nothing to reveal yet
  session.map.revealed = !session.map.revealed;

  context.broadcast(meta.sessionId, (recipient) => ({
    type: 'map:revealed',
    session: filterSessionForRole(session, recipient.role, recipient.playerId),
  }));
}

function handleMapEvent(meta, msg, context) {
  if (meta.role !== 'gm') return;
  const session = context.sessions.get(meta.sessionId);
  if (!session) return;

  if (msg.type === 'map:set') handleMapSet(meta, msg, session, context);
  else if (msg.type === 'map:reveal') handleMapReveal(meta, session, context);
}

export default handleMapEvent;
