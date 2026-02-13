import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    exclude: ['tests/e2e/**', 'node_modules/**', 'dist/**'],
    passWithNoTests: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/index.ts', 'src/**/*.test.ts'],
    },
  },
  resolve: {
    alias: {
      '@meridian/shared': path.resolve(__dirname, 'src/shared/index.ts'),
      '@meridian/axis': path.resolve(__dirname, 'src/axis/index.ts'),
      '@meridian/scout': path.resolve(__dirname, 'src/scout/index.ts'),
      '@meridian/sentinel': path.resolve(__dirname, 'src/sentinel/index.ts'),
      '@meridian/journal': path.resolve(__dirname, 'src/journal/index.ts'),
      '@meridian/bridge': path.resolve(__dirname, 'src/bridge/index.ts'),
      '@meridian/gear': path.resolve(__dirname, 'src/gear/index.ts'),
      '@meridian/main': path.resolve(__dirname, 'src/main.ts'),
    },
  },
});
