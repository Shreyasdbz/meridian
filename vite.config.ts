import path from 'node:path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  plugins: [react()],
  resolve: {
    alias: {
      '@meridian/shared': path.resolve(__dirname, 'src/shared/index.ts'),
      '@meridian/bridge/ui': path.resolve(__dirname, 'src/bridge/ui'),
    },
  },
  build: {
    outDir: 'dist/ui',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true,
        ws: true,
      },
    },
  },
});
