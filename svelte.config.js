import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    alias: {
      // Points at the plain-JS VTT server module (vtt/server/), kept outside
      // src/ so it can also be imported directly (no bundling) by
      // vite.config.ts's dev plugin and by the production server.js.
      $vtt: 'vtt/server'
    }
  }
};

export default config;
