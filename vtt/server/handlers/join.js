// @ts-nocheck — plain untyped JS by design, see vtt/README.md.
import { filterSessionForRole } from '../store.js';

// Handles `join` for both a brand-new join and a reconnect after a dropped
// connection — same code path, full state resend, per spec Section 2.
function handleJoin(meta, msg, context) {
  const { sessions, socketsBySession } = context;
  const { sessionId, role, playerId, playerName } = msg;
  const session = sessions.get(sessionId);

  if (!session) {
    meta.ws.send(JSON.stringify({ type: 'join:error', reason: 'session_not_found' }));
    return;
  }

  meta.sessionId = sessionId;
  meta.role = role === 'gm' ? 'gm' : 'player';
  meta.playerId = meta.role === 'player' ? playerId : null;
  meta.playerName = meta.role === 'player' ? playerName : null;

  // Whoever connects first as GM claims the role for the session; POC has no auth.
  if (meta.role === 'gm' && !session.gmSocketId) {
    session.gmSocketId = playerId || 'gm';
  }

  if (meta.role === 'player') {
    const existing = session.players[playerId];
    session.players[playerId] = {
      id: playerId,
      name: playerName,
      tokenIds: existing ? existing.tokenIds : [],
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
    session: filterSessionForRole(session, meta.role),
  }));

  if (meta.role === 'player') {
    for (const other of sockets) {
      if (other === meta) continue;
      other.ws.send(JSON.stringify({ type: 'player:joined', playerId, playerName }));
    }
  }
}

export default handleJoin;
