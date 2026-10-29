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

/**
 * Register ./sw.js relative to the page (works from a GitHub Pages subpath).
 * A new worker waits (see sw.js); `onUpdate(apply)` fires when one is ready
 * behind a running page, `apply()` activates it and reloads once.
 * @param {{ onUpdate?: (apply: () => void) => void }} [opts]
 */
export function registerServiceWorker({ onUpdate } = {}) {
  const ok = shouldRegisterServiceWorker({
    protocol: globalThis.location?.protocol,
    isElectron: !!globalThis.electronAPI,
    isProd: !!import.meta.env?.PROD,
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  });
  if (!ok) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    // First visit: clients.claim() also fires this; only reload when an update was applied.
    if (!applying || reloading) return;
    reloading = true;
    location.reload();
  });
  let applying = false;
  const announce = (reg) => {
    const waiting = reg.waiting;
    if (!waiting || !navigator.serviceWorker.controller) return;
    onUpdate?.(() => { applying = true; waiting.postMessage({ type: 'SKIP_WAITING' }); });
  };
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js', { scope: './' })
      .then((reg) => {
        announce(reg);
        reg.addEventListener('updatefound', () => {
          const next = reg.installing;
          next?.addEventListener('statechange', () => { if (next.state === 'installed') announce(reg); });
        });
      })
      .catch(err => console.warn('MIXOMESH service worker registration failed:', err));
  });
}
