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
    // During `npm run dev`, proxy backend calls to v1 dev so the live UI works.
    proxy: {
      '/api': 'http://127.0.0.1:4801',
      '/stream': 'http://127.0.0.1:4801',
      '/hls': 'http://127.0.0.1:4801',
      '/omdb-poster': 'http://127.0.0.1:4801',
    },
  },
});
