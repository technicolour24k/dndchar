// @ts-nocheck — plain untyped JS by design, see vtt/README.md.
import { WebSocketServer } from 'ws';
import { sessions, socketsBySession, broadcast } from './store.js';
import handleJoin from './handlers/join.js';
import handleTokenEvent from './handlers/token.js';
import handleMapEvent from './handlers/map.js';

const WS_PATH = '/vtt-ws';
const context = { sessions, socketsBySession, broadcast };

let wss = null;

// Attaches the VTT WebSocket layer to an existing http.Server, filtering
// upgrade requests by path so it coexists with whatever else is listening on
// that server (SvelteKit's own dev-server HMR socket in dev, nothing extra in
// prod). Safe to call more than once per process — only the first call does
// anything.
export function attachVttWebSocketServer(httpServer) {
  if (wss) return wss;
  wss = new WebSocketServer({ noServer: true });

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
          handleTokenEvent(meta, msg, context);
          break;
        case 'map:set':
          handleMapEvent(meta, msg, context);
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (!meta.sessionId) return;
      const sockets = socketsBySession.get(meta.sessionId);
      if (sockets) sockets.delete(meta);
    });
  });

  return wss;
}
