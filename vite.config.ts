import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import type { Plugin } from 'vite';

const PROJECT_ROOT = fileURLToPath(new URL('.', import.meta.url));

/**
 * Serve-only CSP allowance for the React Fast Refresh preamble. plugin-react
 * injects an INLINE module script into index.html in dev; the page CSP has no
 * 'unsafe-inline' for scripts. Hash exactly those inline scripts and append the
 * hashes to script-src. apply:'serve' => the built index.html (and its CSP,
 * pinned by tests/electron-security.test.mjs) is untouched.
 */
function reactRefreshCsp(): Plugin {
  return {
    name: 'mixo-react-refresh-csp',
    apply: 'serve',
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
          .map((m) => m[1])
          .filter((body) => body.trim().length > 0)
          .map((body) => `'sha256-${createHash('sha256').update(body).digest('base64')}'`);
        if (hashes.length === 0) return html;
        return html.replace(/(<meta\s+http-equiv="Content-Security-Policy"\s+content="[^"]*?script-src [^;"]*)/i, `$1 ${hashes.join(' ')}`);
      },
    },
  };
}

/** Vendored mixo-geocore packages (vendor/mixo-geocore, written by scripts/vendor-geometry.mjs). */
export const GEOCORE_ALIAS = {
  '@mixo-geocore/host': resolve(PROJECT_ROOT, 'vendor/mixo-geocore/host'),
  '@mixo-geocore/editing': resolve(PROJECT_ROOT, 'vendor/mixo-geocore/editing'),
};

export default defineConfig({
  plugins: [react(), reactRefreshCsp()],
  resolve: { alias: GEOCORE_ALIAS },
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
  // Pre-bundle the Babylon deep imports used only by the OBJ parse worker /
  // lazy export paths. Discovered late, Vite re-optimises and FULL-RELOADS the
  // page mid-session ("optimized dependencies changed. reloading") — that was
  // the intermittent "Inspected target navigated or closed" in the export
  // smoke, and would drop a dev user's unsaved scene the same way.
  optimizeDeps: {
    include: [
      '@babylonjs/core/Buffers/buffer.js',
      '@babylonjs/core/Engines/nullEngine.js',
      '@babylonjs/core/Loading/sceneLoader.js',
      '@babylonjs/core/Misc/tools.js',
      '@babylonjs/core/scene.js',
      '@babylonjs/loaders/OBJ/index.js',
    ],
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    strictPort: true,
  },
  build: {
    target: 'es2024',
    // Fonts always ship as files: CSP has no font-src, so default-src 'self'
    // blocks data: fonts (small @fontsource subsets would otherwise inline).
    assetsInlineLimit: (filePath) => (/\.(woff2?|ttf|otf)$/.test(filePath) ? false : undefined),
    sourcemap: true,
    // Temporary while src/app/boot.ts bundles the Babylon namespace bridge
    // plus the migrated JS modules into one Vite entry. Lower this after
    // domain-level code splitting lands.
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      input: {
        app: resolve(PROJECT_ROOT, 'index.html'),
      },
      // Keep /*! */ legal comments (licence credits, e.g. Lucide in Icons.js)
      // in the minified bundle — licence scan M1.
      output: { comments: { legal: true } },
    },
    // NOTE (perf audit 2026-06-13): forcing a @babylonjs manualChunks vendor
    // chunk under rolldown DEFEATS tree-shaking — the vendor chunk came out
    // 7.3 MB vs the 4.2 MB tree-shaken boot chunk. Don't re-add it. mp4-muxer
    // splits itself out via the dynamic import in RenderOutput.js.
  },
});
