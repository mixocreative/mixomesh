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
 * Vendor engine warm-up (PW.2b): same gate as registration, plus never on data-saver.
 * @param {{ protocol?: string, isElectron?: boolean, isProd?: boolean, hasServiceWorker?: boolean, saveData?: boolean }} ctx
 * @returns {boolean}
 */
export function shouldPrefetchVendor(ctx = {}) {
  if (ctx.saveData) return false;
  return shouldRegisterServiceWorker(ctx);
}

/**
 * Once a service worker controls the page, ask it (when the browser is idle) to cache the
 * vendor engines, so they work offline before a user ever opens repair/Boolean/Draco/supports.
 * First visit: the worker only controls the page after clients.claim(), hence the wait.
 */
function armVendorPrefetch() {
  const sw = navigator.serviceWorker;
  const send = () => {
    const run = () => sw.controller?.postMessage({ type: 'prefetch-vendor' });
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 5000 });
    else setTimeout(run, 2000);
  };
  if (sw.controller) send();
  else sw.addEventListener('controllerchange', send, { once: true });
}

/**
 * Register ./sw.js relative to the page (works from a GitHub Pages subpath).
 * A new worker waits (see sw.js); `onUpdate(apply)` fires when one is ready
 * behind a running page, `apply()` activates it and reloads once.
 * @param {{ onUpdate?: (apply: () => void) => void }} [opts]
 */
export function registerServiceWorker({ onUpdate } = {}) {
  const ctx = {
    protocol: globalThis.location?.protocol,
    isElectron: !!globalThis.electronAPI,
    isProd: !!import.meta.env?.PROD,
    hasServiceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator,
  };
  const ok = shouldRegisterServiceWorker(ctx);
  if (!ok) return;
  const prefetch = shouldPrefetchVendor({ ...ctx, saveData: navigator.connection?.saveData === true });
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
    if (prefetch) armVendorPrefetch();
  });
}
