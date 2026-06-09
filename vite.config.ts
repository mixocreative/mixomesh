import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: PROJECT_ROOT,
  appType: 'spa',
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2024',
    sourcemap: true,
    // Temporary while src/app/boot.ts bundles the Babylon namespace bridge
    // plus the migrated JS modules into one Vite entry. Lower this after
    // domain-level code splitting lands.
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      input: {
        app: resolve(PROJECT_ROOT, 'index.html'),
      },
    },
  },
});
