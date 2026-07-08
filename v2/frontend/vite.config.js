import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // During `npm run dev`, proxy backend calls to the live prod server so
    // the UI runs against real data without stopping any service.
    proxy: Object.fromEntries(
      ['/api', '/stream', '/hls', '/hls.min.js', '/poster', '/omdb-poster', '/backdrop', '/sprite', '/subtitle']
        .map((p) => [p, 'http://127.0.0.1:4800']),
    ),
  },
});
