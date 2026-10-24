// @ts-nocheck - plain untyped JS by design, see vtt/README.md.
import { WebSocketServer } from 'ws';
import { sessions, socketsBySession, broadcast, setWatches, removeWatcher } from './store.js';
import handleJoin from './handlers/join.js';
import handleTokenEvent from './handlers/token.js';
import handleMapEvent from './handlers/map.js';
import handleMarkerEvent from './handlers/marker.js';
import handleTargetEvent from './handlers/target.js';
import handleSoundboardEvent from './handlers/soundboard.js';
import handleDiceEvent from './handlers/dice.js';

const WS_PATH = '/vtt-ws';

// db-traffic-reduction Phase 5: a "watch" subscription is unauthenticated,
// same as the rest of this ws server (small trusted group, user decision) -
// topic shape is validated so a client can't subscribe to an unbounded or
// malformed topic string. At most 10 per socket (also enforced defensively
// in store.js's setWatches).
const WATCH_TOPIC_PATTERN = /^(room|game-session):[A-Za-z0-9-]{1,64}$/;
const MAX_WATCH_TOPICS = 10;
const HEARTBEAT_INTERVAL_MS = 30_000;

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

  // 5a. Heartbeat: every socket gets a native ping each round; one that
  // didn't pong back since the *previous* round is assumed dead and
  // terminated. Also lets a watcher-only socket (never joined a session, so
  // it has no VTT traffic of its own to notice a dead path from) detect one
  // via the app-level {type:'hb'} frame below. Created once per process
  // (guarded by the `if (wss) return wss;` above) and cleared if the wss
  // itself is ever closed (not expected in normal operation, but keeps a
  // stray interval from outliving its server on e.g. a test teardown).
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
      if (ws.vttMeta?.watchTopics?.size) {
        ws.send(JSON.stringify({ type: 'hb' }));
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  wss.on('close', () => clearInterval(heartbeatInterval));

  wss.on('connection', (ws) => {
    const meta = { ws, sessionId: null, role: null, playerId: null, playerName: null, watchTopics: new Set() };
    ws.vttMeta = meta;
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

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
        // 5c. A sheet (or Session Notes modal) subscribing to a narrow slice
        // of events, unrelated to (and not requiring) a 'join' - see
        // store.js's setWatches/publish. Replaces the whole topic list each
        // time, so a subsequent 'watch' with a different list is how a
        // caller changes/drops subscriptions on the same socket.
        case 'watch': {
          const requested = Array.isArray(msg.topics) ? msg.topics : [];
          const valid = requested
            .filter((topic) => typeof topic === 'string' && WATCH_TOPIC_PATTERN.test(topic))
            .slice(0, MAX_WATCH_TOPICS);
          setWatches(meta, valid);
          break;
        }
        case 'token:add':
        case 'token:remove':
        case 'token:remove:bulk':
        case 'token:move':
        case 'token:move:resetAll':
        case 'token:stat:update':
        case 'token:update':
        case 'token:hidden:toggle':
        case 'attack:resolve':
        case 'spell:resolve':
          handleTokenEvent(meta, msg, context);
          break;
        case 'map:set':
        case 'map:reveal':
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
        case 'dice:roll':
          handleDiceEvent(meta, msg, context);
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      // Runs regardless of whether this socket ever joined a session - a
      // watch-only socket (sheet/Session Notes modal) has meta.sessionId ===
      // null and must still be cleaned out of watchersByTopic.
      removeWatcher(meta);
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
