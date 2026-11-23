// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import crypto from 'node:crypto';

// "Next round waits for Ready" (vtt-feedback unit 12). The pending round lives in memory on the room:
//
//   session.roundPending = { id, requestedAt, requestedBy, members: { [userId]: { name, ready, holding } } }
//
// `members` is the expected set: connected players who own a character with a token on the map. A
// restart drops the pending round with the room, which is fine. Everything here is pure (no database,
// no sockets of its own) so it can be tested with fake sessions; the route layer does the processing.
//
// Plain objects, never Sets, because the GM's state:full serialises the session as it goes.

// A live socket is one that has joined the room as a player and is still open.
function isLivePlayerSocket(meta) {
  return meta.role === 'player' && !!meta.playerId && meta.ws?.readyState === meta.ws?.OPEN;
}

// True when this player has a socket in the room right now (another tab keeps them in the set).
export function playerIsConnected(sockets, userId) {
  if (!sockets) return false;
  for (const meta of sockets) if (isLivePlayerSocket(meta) && meta.playerId === userId) return true;
  return false;
}

// Does this player own a character's token on the map? Owner comes from the token (set by the server
// when it was added), and a token with no character has nothing to tick so it doesn't count.
export function ownsCharacterToken(session, userId) {
  return Object.values(session.tokens ?? {}).some((token) => token.ownerId === userId && !!token.characterId);
}

// The userIds a round waits for. Campaign rooms only: a Quick room's player ids are whatever the
// client claimed, so they can't be matched to a signed-in account and would never be able to press Ready.
export function expectedUserIds(session, sockets) {
  if (!session.campaignId || !sockets) return [];
  const out = new Set();
  for (const meta of sockets) {
    if (isLivePlayerSocket(meta) && ownsCharacterToken(session, meta.playerId)) out.add(meta.playerId);
  }
  return [...out];
}

function nameOf(session, userId) {
  return session.players?.[userId]?.name || 'A player';
}

// Opens a pending round (replacing nothing: the caller refuses when one is already pending).
export function openPending(session, userIds, requestedBy, now = Date.now()) {
  const members = {};
  for (const userId of userIds) members[userId] = { name: nameOf(session, userId), ready: false, holding: false };
  session.roundPending = { id: crypto.randomUUID(), requestedAt: now, requestedBy, members };
  return session.roundPending;
}

// Ready and hold. Only a member can change anything (false otherwise). Hold clears ready and Ready
// clears hold, so a player is always in exactly one of waiting, holding or ready.
export function setReady(session, userId) {
  const member = session.roundPending?.members[userId];
  if (!member) return false;
  member.ready = true;
  member.holding = false;
  return true;
}
export function setHolding(session, userId) {
  const member = session.roundPending?.members[userId];
  if (!member) return false;
  member.ready = false;
  member.holding = true;
  return true;
}

// A disconnected player stops holding the table up. False when they weren't in the set.
export function dropMember(session, userId) {
  const pending = session.roundPending;
  if (!pending?.members[userId]) return false;
  delete pending.members[userId];
  return true;
}

// A player who reconnects mid-pending is expected again (not ready) if they're on the map. False
// when nothing changed (no pending round, already a member, or no token of theirs).
export function rejoinMember(session, userId) {
  const pending = session.roundPending;
  if (!pending || pending.members[userId] || !session.campaignId || !ownsCharacterToken(session, userId)) return false;
  pending.members[userId] = { name: nameOf(session, userId), ready: false, holding: false };
  return true;
}

// Everyone expected has pressed Ready. An empty set counts as complete (the last player left).
export function isComplete(pending) {
  return Object.values(pending.members).every((member) => member.ready);
}

// What the GM sees: every player and where they stand.
export function gmView(pending) {
  const entries = Object.entries(pending.members).map(([userId, member]) => ({ userId, name: member.name, ready: member.ready, holding: member.holding }));
  return {
    id: pending.id,
    requestedAt: pending.requestedAt,
    waiting: entries.filter((e) => !e.ready && !e.holding),
    holding: entries.filter((e) => e.holding),
    ready: entries.filter((e) => e.ready)
  };
}

// What one player sees: only their own standing. null when they aren't waited on. Never anyone else.
export function playerView(pending, userId) {
  const member = pending?.members[userId];
  if (!member) return null;
  return { id: pending.id, state: member.holding ? 'holding' : member.ready ? 'ready' : 'waiting' };
}

// Tells the GM and each expected player where things stand. Used on every change (the first message is
// `round:pending`, later ones `round:pending:update` for the GM and `round:pending` again for a player,
// whose card just redraws). Watchers and other players get nothing.
export function announce(session, broadcast, type = 'round:pending:update') {
  const pending = session.roundPending;
  if (!pending) return;
  broadcast(session.id, (recipient) => {
    if (recipient.role === 'gm') return { type, pending: gmView(pending) };
    if (recipient.role !== 'player') return null;
    const view = playerView(pending, recipient.playerId);
    return view ? { type: 'round:pending', view } : null;
  });
}

// Used by the join handler: a reconnecting player is expected again and the GM sees them come back.
// Returns true when the set changed (state:full then carries the player's own view).
export function rejoinAndAnnounce(session, userId, broadcast) {
  if (!rejoinMember(session, userId)) return false;
  broadcast(session.id, (recipient) => (recipient.role === 'gm' ? { type: 'round:pending:update', pending: gmView(session.roundPending) } : null));
  return true;
}

// What state:full carries in `roundPending`: the GM gets the full view, a player only their own, and
// nobody else (the raw object, with every player's readiness, never leaves the server).
export function roundPendingFor(session, role, playerId) {
  const pending = session.roundPending;
  if (!pending) return null;
  if (role === 'gm') return gmView(pending);
  return role === 'player' ? playerView(pending, playerId) : null;
}
