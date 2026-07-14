import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';
import type { Plugin, ViteDevServer } from 'vite';
import { attachVttWebSocketServer } from './vtt/server/wsServer.js';

// Attaches the VTT WebSocket layer directly to Vite's dev http.Server so it
// shares the same port as the rest of the app in dev (`vite dev`, :5173).
// The equivalent for production is server.js, which wraps adapter-node's
// handler the same way.
function vttWebSocketPlugin(): Plugin {
  return {
    name: 'vtt-websocket',
    configureServer(server: ViteDevServer) {
      if (server.httpServer) attachVttWebSocketServer(server.httpServer);
    }
  };
}

export default defineConfig({
  plugins: [sveltekit(), vttWebSocketPlugin()],
  test: {
    include: ['src/**/*.test.ts']
  }
});
