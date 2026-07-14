// Production entry point (replaces adapter-node's default `node build`).
// Wraps SvelteKit's generated handler in a plain http.Server so the VTT
// WebSocket layer can attach to the same port/process — the same pattern
// src/lib/server/realtime.ts already anticipated for a future Socket.IO
// server ("attach a Socket.IO server around the adapter-node handler").
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import { attachVttWebSocketServer } from './vtt/server/wsServer.js';

const port = process.env.PORT || 3000;
const server = createServer(handler);

attachVttWebSocketServer(server);

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
