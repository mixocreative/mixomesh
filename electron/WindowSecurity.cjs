// Window / webContents hardening for the Electron shell (task 6.1, Decision 19).
// Pure functions + injectable Electron objects so tests/electron-security.test.mjs
// can exercise every rule without launching Electron.
//
// Rules:
//  - Navigation: the renderer may only (re)load the app's own document — the
//    built `dist/index.html` file URL or the Vite dev server origin. Anything
//    else (`will-navigate`, `will-redirect`) is cancelled.
//  - New windows: `setWindowOpenHandler` denies every request (no popups, no
//    `target=_blank`, no `window.open`).
//  - <webview>: never attached.
//  - Permissions: every request and every check is denied (camera, mic,
//    notifications, clipboard-read, fullscreen, …) EXCEPT
//    `clipboard-sanitized-write` — the cost card's "copy path" button uses
//    navigator.clipboard.writeText (write-only, plain text).
//  - IPC: every handler checks the sender frame is the app's top frame.

const { pathToFileURL } = require('node:url');

/** Hardened BrowserWindow webPreferences — the single source for createWindow. */
const SECURE_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,   // renderer can't reach the preload's Node world
  nodeIntegration: false,   // no require()/process in the page
  sandbox: true,            // renderer + preload run in the Chromium sandbox
  webSecurity: true,
  allowRunningInsecureContent: false,
  webviewTag: false,
  navigateOnDragDrop: false, // an OS file dropped outside a drop zone must not replace the app
});

/**
 * The app's own entry URL: the dev server URL when set, else the built index.
 * @param {{devUrl?: string, indexPath: string}} opts
 */
function appEntryUrl({ devUrl, indexPath }) {
  return devUrl ? new URL(devUrl).href : pathToFileURL(indexPath).href;
}

/**
 * True when `url` is the app's own document (query/hash ignored). Dev: any
 * path on the dev server's exact origin (Vite serves /index.html and /).
 * Built: exactly the dist index.html file URL — no other file:// page.
 * @param {string} url
 * @param {string} entryUrl from appEntryUrl()
 */
function isAppUrl(url, entryUrl) {
  let target;
  let entry;
  try {
    target = new URL(String(url));
    entry = new URL(entryUrl);
  } catch {
    return false;
  }
  if (entry.protocol === 'file:') {
    if (target.protocol !== 'file:') return false;
    const norm = u => decodeURIComponent(u.pathname).replace(/\\/g, '/').toLowerCase();
    return target.host === entry.host && norm(target) === norm(entry);
  }
  if (entry.protocol !== 'http:' && entry.protocol !== 'https:') return false;
  return target.origin === entry.origin;
}

/**
 * Attach navigation / window-open / webview / permission guards.
 * @param {Electron.WebContents} contents
 * @param {string} entryUrl
 * @param {{onBlocked?: (kind: string, url: string) => void}} [opts]
 */
function guardWebContents(contents, entryUrl, opts = {}) {
  const blocked = (kind, url) => { try { opts.onBlocked?.(kind, url); } catch { /* reporting only */ } };
  const denyNav = (event, url) => {
    if (isAppUrl(url, entryUrl)) return;
    event.preventDefault();
    blocked('navigate', url);
  };
  contents.on('will-navigate', denyNav);
  contents.on('will-redirect', denyNav);
  contents.on('will-attach-webview', event => { event.preventDefault(); blocked('webview', ''); });
  contents.setWindowOpenHandler(({ url }) => { blocked('window-open', url); return { action: 'deny' }; });
}

const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);

/** True only for the allowlisted permissions above. */
function isPermissionAllowed(permission) {
  return ALLOWED_PERMISSIONS.has(permission);
}

/**
 * Deny every permission request / check on a session (allowlist above).
 * @param {Electron.Session} session
 */
function denyAllPermissions(session) {
  session.setPermissionRequestHandler((_contents, permission, callback) => callback(isPermissionAllowed(permission)));
  session.setPermissionCheckHandler((_contents, permission) => isPermissionAllowed(permission));
  session.setDevicePermissionHandler?.(() => false);
}

/**
 * IPC sender check: the message must come from the app's top-level frame.
 * @param {{senderFrame?: {url?: string, parent?: unknown} | null}} event
 * @param {string} entryUrl
 */
function isTrustedSender(event, entryUrl) {
  const frame = event?.senderFrame;
  if (!frame || frame.parent) return false;
  return isAppUrl(frame.url, entryUrl);
}

module.exports = {
  SECURE_WEB_PREFERENCES,
  appEntryUrl,
  isAppUrl,
  guardWebContents,
  denyAllPermissions,
  isPermissionAllowed,
  isTrustedSender,
};
