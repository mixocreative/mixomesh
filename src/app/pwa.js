// PWA registration policy (task 8.7). Pure so tests/pwa.test.mjs can pin it.
// The service worker (public/sw.js) is for the HOSTED web build only: never the
// Vite dev server (stale-cache hazard, HMR), never Electron (file:// cannot
// register one and the shell owns its own offline story).

/**
 * @param {{ protocol?: string, isElectron?: boolean, isProd?: boolean, hasServiceWorker?: boolean }} ctx
 * @returns {boolean}
 */
export function shouldRegisterServiceWorker({ protocol, isElectron, isProd, hasServiceWorker } = {}) {
  if (!hasServiceWorker || !isProd || isElectron) return false;
  return protocol === 'http:' || protocol === 'https:';
}

/** Register ./sw.js relative to the page (works from a GitHub Pages subpath). */
export function registerServiceWorker() {
  const ok = shouldRegisterServiceWorker({
    protocol: globalThis.location?.protocol,
    isElectron: !!globalThis.electronAPI,
    isProd: !!import.meta.env?.PROD,
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  });
  if (!ok) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .catch(err => console.warn('MIXOMESH service worker registration failed:', err));
  });
}
