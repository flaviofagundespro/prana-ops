import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite config for the Prana OPS SPA.
 *
 * `build.outDir` resolves to `web/dist`, which the backend serves statically
 * (see server/src/http/app.ts). The dev server proxies /api and /ws to the
 * backend on :4000 for `vite`-based development.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4000',
      '/ws': { target: 'ws://localhost:4000', ws: true },
    },
  },
});
