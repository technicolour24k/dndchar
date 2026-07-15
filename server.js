// Production entry point (replaces adapter-node's default `node build`).
// Wraps SvelteKit's generated handler in a plain http.Server so the VTT
// WebSocket layer can attach to the same port/process - the same pattern
// src/lib/server/realtime.ts already anticipated for a future Socket.IO
// server ("attach a Socket.IO server around the adapter-node handler").
import { createServer } from 'node:http';
import { handler } from './build/handler.js';
import { attachVttWebSocketServer } from './vtt/server/wsServer.js';

const port = process.env.PORT || 3000;

// The VTT client (static/vtt-app/*) is plain, UNHASHED files - index.html,
// main.js, style.css, render/*.js - whose names never change between deploys,
// and adapter-node serves them with no Cache-Control header. Behind a caching
// edge (Railway fronts requests with Cloudflare, which caches .js/.css by
// extension) that means a deployed change is invisible until the edge entry
// ages out: exactly the bug where a new main.js shipped but the browser kept
// getting the old one. Force revalidation so every load picks up the current
// deploy. These files are tiny and this path is low-traffic, so the cost is
// nil; correctness matters far more than caching them. (Hashed SvelteKit
// assets under /_app/immutable are untouched - those are safe to cache forever
// precisely because their names DO change per build.)
const server = createServer((req, res) => {
  if (req.url && req.url.startsWith('/vtt-app')) {
    res.setHeader('Cache-Control', 'no-cache');
  }
  handler(req, res);
});

attachVttWebSocketServer(server);

server.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});
