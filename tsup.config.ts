import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts', 'src/cli/index.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: true,
  sourcemap: true,
  splitting: false,
  external: [
    'better-sqlite3',
    'argon2',
    'bcrypt',
    'isolated-vm',
  ],
  banner: {
    js: '#!/usr/bin/env node',
  },
});
