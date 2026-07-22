// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { WebSocketServer } from 'ws';
import { sessions, socketsBySession, broadcast } from './store.js';
import handleJoin from './handlers/join.js';
import handleTokenEvent from './handlers/token.js';
import handleMapEvent from './handlers/map.js';
import handleMarkerEvent from './handlers/marker.js';
import handleTargetEvent from './handlers/target.js';
import handleSoundboardEvent from './handlers/soundboard.js';

const WS_PATH = '/vtt-ws';

// token.js needs to persist combat-log rows via POST /vtt/api/log, but it can't
// import $lib/server/services/combatLog.ts directly (see that route's own
// comment for why) - it calls back into this same process over loopback HTTP
// instead. Both dev (vite.config.ts) and prod (server.js) pass the *real*
// listening httpServer into attachVttWebSocketServer, so reading its bound port
// here works in both without a separate PORT env var to keep in sync.
//
// Uses the `localhost` hostname, not the literal 127.0.0.1 - on some Windows
// setups Node's http.Server ends up bound only to the IPv6 loopback (::1),
// which a browser reaches fine via `localhost` (its resolver tries both) but a
// hardcoded IPv4 literal cannot reach at all (ECONNREFUSED even though the
// server is genuinely listening). `localhost` lets Node's own resolution do
// the same dual-stack fallback the browser already relies on.
function internalApiBaseUrl(httpServer) {
  const addr = httpServer.address();
  const port = addr && typeof addr === 'object' ? addr.port : (process.env.PORT || 3000);
  return `http://localhost:${port}`;
}

let wss = null;

// Attaches the VTT WebSocket layer to an existing http.Server, filtering
// upgrade requests by path so it coexists with whatever else is listening on
// that server (SvelteKit's own dev-server HMR socket in dev, nothing extra in
// prod). Safe to call more than once per process - only the first call does
// anything.
export function attachVttWebSocketServer(httpServer) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });

  const context = {
    sessions,
    socketsBySession,
    broadcast,
    internalApiBaseUrl: () => internalApiBaseUrl(httpServer),
  };

  httpServer.on('upgrade', (request, socket, head) => {
    const { pathname } = new URL(request.url ?? '', 'http://localhost');
    if (pathname !== WS_PATH) return;
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws) => {
    const meta = { ws, sessionId: null, role: null, playerId: null, playerName: null };

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (msg.type) {
        case 'join':
          handleJoin(meta, msg, context);
          break;
        case 'token:add':
        case 'token:remove':
        case 'token:move':
        case 'token:stat:update':
        case 'token:hidden:toggle':
        case 'attack:resolve':
        case 'spell:resolve':
          handleTokenEvent(meta, msg, context);
          break;
        case 'map:set':
          handleMapEvent(meta, msg, context);
          break;
        case 'marker:add':
        case 'marker:remove':
        case 'marker:visibility:toggle':
          handleMarkerEvent(meta, msg, context);
          break;
        case 'target:select':
        case 'target:clear':
          handleTargetEvent(meta, msg, context);
          break;
        case 'soundboard:play':
          handleSoundboardEvent(meta, msg, context);
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (!meta.sessionId) return;
      const sockets = socketsBySession.get(meta.sessionId);
      if (sockets) sockets.delete(meta);

      const session = sessions.get(meta.sessionId);
      if (!session) return;

      if (meta.role === 'player' && meta.playerId && session.players[meta.playerId]) {
        // Don't delete the player outright - they should reappear correctly
        // on reconnect via the same state:full path join.js already uses.
        session.players[meta.playerId].connected = false;
        broadcast(meta.sessionId, () => ({ type: 'player:left', playerId: meta.playerId }));
      } else if (meta.role === 'gm' && session.gmSocketId === (meta.playerId || 'gm')) {
        session.gmSocketId = null;
      }
    });
  });

  return wss;
}
