import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: PROJECT_ROOT,
  appType: 'spa',
  // Relative base so the built app runs from ANY location without edits:
  //  - GitHub Pages project sites serve from https://<user>.github.io/<repo>/
  //  - the Electron desktop shell loads dist/index.html over file://
  // Absolute ('/') asset URLs break both; './' resolves them against the page.
  base: './',
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
    // NOTE (perf audit 2026-06-13): forcing a @babylonjs manualChunks vendor
    // chunk under rolldown DEFEATS tree-shaking — the vendor chunk came out
    // 7.3 MB vs the 4.2 MB tree-shaken boot chunk. Don't re-add it. mp4-muxer
    // splits itself out via the dynamic import in RenderOutput.js.
  },
});
