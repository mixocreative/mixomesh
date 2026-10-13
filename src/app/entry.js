// HTML entry module (task 6.1). Replaces the two inline <script> blocks that
// used to live in index.html so the Content-Security-Policy can forbid inline
// script outright (`script-src 'self'`, no 'unsafe-inline', no hashes).
//
//  1. A last-resort `error` listener: any uncaught error before the app shell
//     removes #boot-status turns the "Loading…" banner into a visible failure.
//  2. The dynamic boot import. Raw (non-Vite) serving cannot load the .ts
//     module, which lands in the catch and explains how to run the app.

const BOOT_FAILED = 'Failed to initialise MIXOMESH. Check DevTools for details.';
const NEEDS_VITE = 'MIXOMESH must be served by Vite. Run npm run dev and open http://127.0.0.1:5173/index.html.';

function showBootError(message) {
  const boot = document.getElementById('boot-status');
  if (!boot) return;
  boot.textContent = message;
  boot.classList.add('boot-status-error');
  boot.hidden = false;
}

window.addEventListener('error', () => showBootError(BOOT_FAILED));

import('./boot.ts').catch(err => {
  console.error('MIXOMESH boot module failed:', err);
  showBootError(NEEDS_VITE);
});
