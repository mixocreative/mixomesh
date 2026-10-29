import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { GEOCORE_ALIAS } from './vite.config';

// Component/unit tests for src/**. The node:test suite in tests/ is separate
// (`npm test` runs both). .tsx tests run in jsdom, .ts tests in node.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: GEOCORE_ALIAS },
  test: {
    projects: [
      { extends: true, test: { name: 'node', environment: 'node', include: ['src/**/*.test.ts'] } },
      { extends: true, test: { name: 'jsdom', environment: 'jsdom', include: ['src/**/*.test.tsx'] } },
    ],
  },
});
