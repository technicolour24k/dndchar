// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { consumeJoinTicket, filterSessionForRole, releaseSocket } from '../store.js';

// A live GM socket in the room other than `except` (a socket re-joining must not count itself).
function liveGmSocketExcept(sockets, except) {
  if (!sockets) return null;
  for (const entry of sockets) {
    if (entry !== except && entry.role === 'gm' && entry.ws.readyState === entry.ws.OPEN) return entry;
  }
  return null;
}

// Handles `join` for both a brand-new join and a reconnect after a dropped
// connection - same code path, full state resend, per spec Section 2.
//
// Two paths:
//
// 1. Quick rooms (no session.campaignId, no ticket): exactly the original behaviour. Role and
//    playerId come straight from the client message and the first live GM wins. There is no
//    auth here, which is the accepted POC gap for throwaway rooms.
//
// 2. Campaign rooms (session.campaignId set): the join must carry a one-use `ticket` issued by
//    POST /vtt/api/campaigns/<id>/ticket, which checked the user's real campaign membership. User
//    id, display name, role and GM-seat rank all come from the ticket; whatever the message says
//    is ignored. A ticket-less join to a campaign room is refused.
//
// GM seat (one per room), ticketed joins only. `seat` is 'primary' (the primary DM) or 'co':
//
//   who asks      | seat empty | held by co-DM                       | held by primary DM
//   primary DM    | takes it   | gm_seat_taken (canTakeOver); with    | gm_seat_taken (canTakeOver) if it
//                 |            | takeoverOf:'co' replaces it          | is their own socket (second tab or
//                 |            | (takeoverOf:'self' if it is theirs)  | a stale one after sleep), with
//                 |            |                                      | takeoverOf:'self'; else n/a
//   co-DM         | takes it   | gm_seat_taken (canTakeOver) if it is | gm_already_claimed, never takeover
//                 |            | their own socket (takeoverOf:'self'),|
//                 |            | else n/a                             |
//   player ticket | can never be GM, whatever the message says
//
// So a takeover is allowed in exactly two cases: the primary DM over the co-DM, and a DM over their
// OWN older socket (which the new socket then replaces). The ticket route lets any DM ask for a
// takeover and records WHICH kind (takeoverOf 'self' or 'co'); this handler applies it only if it
// matches who holds the seat at join time, otherwise the asker gets gm_seat_taken and is asked again. A stale claim (gmSocketId set but no
// live GM socket) is reclaimable by either DM without a takeover.
//
// A socket that is already in a room and joins another is first released from the old room (same
// clean-up as a close: set membership, player entry, GM seat).
function handleJoin(meta, msg, context) {
  const { sessions, socketsBySession } = context;
  const { sessionId } = msg;
  const session = sessions.get(sessionId);

  if (!session) {
    meta.ws.send(JSON.stringify({ type: 'join:error', reason: 'session_not_found' }));
    return;
  }

  // Resolve identity before touching `meta`, so a rejected join leaves the socket untouched.
  let role;
  let playerId;
  let playerName;
  let ticket = null;
  if (msg.ticket != null || session.campaignId) {
    if (msg.ticket == null || msg.ticket === '') {
      meta.ws.send(JSON.stringify({ type: 'join:error', reason: 'ticket_required' }));
      return;
    }
    ticket = consumeJoinTicket(msg.ticket);
    if (!ticket || ticket.sessionId !== sessionId) {
      meta.ws.send(JSON.stringify({ type: 'join:error', reason: 'bad_ticket' }));
      return;
    }
    role = ticket.role;
    playerId = ticket.userId;
    playerName = ticket.displayName;
  } else {
    role = msg.role;
    playerId = msg.playerId;
    playerName = msg.playerName;
  }

  const wantsGm = role === 'gm';
  let replacedGm = null;

  if (wantsGm) {
    const liveGm = liveGmSocketExcept(socketsBySession.get(sessionId), meta);
    if (session.gmSocketId && liveGm) {
      if (!ticket) {
        // Quick room: a second live GM socket is rejected outright (stale claims are reclaimable).
        meta.ws.send(JSON.stringify({ type: 'join:error', reason: 'gm_already_claimed' }));
        return;
      }
      const sameUser = liveGm.gmUserId === ticket.userId;
      const primaryOverCo = ticket.seat === 'primary' && liveGm.gmSeat === 'co';
      if (!sameUser && !primaryOverCo) {
        meta.ws.send(JSON.stringify({ type: 'join:error', reason: 'gm_already_claimed' }));
        return;
      }
      // The ticket must ask for the takeover that matches who holds the seat RIGHT NOW. 'self' only
      // replaces the asker's own older socket, 'co' only the co-DM (primary DM asking). If the seat
      // changed hands after the client was told (say the stale socket closed and the co-DM sat down),
      // the intent no longer matches and the client gets the normal question instead of a displacement.
      const intentMatches =
        (ticket.takeoverOf === 'self' && sameUser) || (ticket.takeoverOf === 'co' && primaryOverCo && !sameUser);
      if (!intentMatches) {
        // heldBy tells the client whether the seat holder is the asker's own older socket (a second
        // tab, a refresh, a stale socket after sleep: the client takes over without asking on an
        // automatic reconnect) or somebody else (the co-DM: the client asks first).
        meta.ws.send(JSON.stringify({
          type: 'join:error', reason: 'gm_seat_taken', canTakeOver: true, heldBy: sameUser ? 'self' : 'other'
        }));
        return;
      }
      replacedGm = liveGm;
    }
  }

  // Accepted. Leave any room this socket was already in first (a hop), so it isn't in two rooms'
  // sets and doesn't keep a GM seat it no longer has.
  if (meta.sessionId) releaseSocket(meta);

  meta.sessionId = sessionId;
  meta.role = wantsGm ? 'gm' : 'player';
  meta.playerId = meta.role === 'player' ? playerId : null;
  meta.playerName = meta.role === 'player' ? playerName : null;
  // The account behind a ticketed socket, so a kick finds it whichever role it joined as.
  meta.userId = ticket ? ticket.userId : null;

  if (wantsGm) {
    session.gmSocketId = playerId || 'gm';
    // Remembered on the socket so the release can tell whether THIS socket is the GM
    // gmSocketId points at (meta.playerId is always null for a GM).
    meta.gmUserId = session.gmSocketId;
    meta.gmSeat = ticket ? ticket.seat : null;
  }

  // Takeover: gmSocketId was already pointed at the new GM above, BEFORE the old socket closes, so
  // the old socket's release (which only clears gmSocketId when no other live GM socket exists and
  // it still matches) leaves the new GM seated.
  if (replacedGm) {
    replacedGm.ws.send(JSON.stringify({ type: 'gm:replaced' }));
    replacedGm.ws.close(4002);
  }

  if (meta.role === 'player') {
    const existing = session.players[playerId];
    session.players[playerId] = {
      id: playerId,
      name: playerName,
      tokenIds: existing ? existing.tokenIds : [],
      connected: true,
    };
  }

  let sockets = socketsBySession.get(sessionId);
  if (!sockets) {
    sockets = new Set();
    socketsBySession.set(sessionId, sockets);
  }
  sockets.add(meta);

  meta.ws.send(JSON.stringify({
    type: 'state:full',
    session: filterSessionForRole(session, meta.role, meta.playerId),
  }));

  if (meta.role === 'player') {
    for (const other of sockets) {
      if (other === meta) continue;
      other.ws.send(JSON.stringify({ type: 'player:joined', playerId, playerName }));
    }
  }
}

export default handleJoin;
