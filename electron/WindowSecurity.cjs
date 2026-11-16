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
//  - Devices (HID / serial / USB): denied. BLUETOOTH is denied too, except a
//    device whose advertised name is an orientation puck's — see
//    `chooseBluetoothDevice`, which is the whole of that exception.
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

/**
 * The orientation puck's advertised name prefix (mixospatial `PROTOCOL.md` §4: `mixo-NNN`, the
 * number assigned at build time so two pucks on one desk can be told apart).
 *
 * This string is the whole of the Bluetooth exception below. Widening it widens what a compromised
 * renderer can reach on the air, so it stays a prefix match on a name this project assigns.
 */
const PUCK_NAME_PREFIX = 'mixo-';

/** How long to keep scanning before giving up and failing the request. */
const BLUETOOTH_SCAN_TIMEOUT_MS = 15000;

/**
 * Which device, out of everything the scan has seen so far, the renderer may have.
 *
 * Pure, and the single place the answer is decided: Electron ships NO Bluetooth chooser UI, so
 * unlike Chrome there is no dialog in which a person picks one device and rules out the rest. An
 * app that answers `devices[0]` hands the page whatever happens to be advertising nearby — a
 * colleague's headset, a phone — which is a wider grant than the browser would ever have made.
 *
 * @param {Array<{deviceId?: string, deviceName?: string}>} devices
 * @param {string} [prefix]
 * @returns {string} the chosen `deviceId`, or `''` for "none of these"
 */
function chooseBluetoothDevice(devices, prefix = PUCK_NAME_PREFIX) {
  const list = Array.isArray(devices) ? devices : [];
  const match = list.find(d => typeof d?.deviceName === 'string'
    && d.deviceName.startsWith(prefix)
    && typeof d.deviceId === 'string'
    && d.deviceId.length > 0);

  return match ? match.deviceId : '';
}

/**
 * Let the renderer reach an orientation puck, and nothing else on the air.
 *
 * `select-bluetooth-device` fires AGAIN for every device the scan turns up, so answering `''` on
 * the first miss would cancel a scan that had not yet found the puck. It therefore stays silent
 * until a name matches — with a timeout, because `requestDevice()` returns a promise nobody else
 * will ever settle, and a Connect button that hangs for ever is worse than one that reports a
 * failure.
 *
 * @param {Electron.WebContents} contents
 * @param {{namePrefix?: string, timeoutMs?: number}} [opts]
 */
function allowPuckBluetooth(contents, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? BLUETOOTH_SCAN_TIMEOUT_MS;
  let timer = null;

  contents.on('select-bluetooth-device', (event, devices, callback) => {
    event.preventDefault();

    const chosen = chooseBluetoothDevice(devices, opts.namePrefix);

    if (chosen) {
      if (timer) { clearTimeout(timer); timer = null; }
      callback(chosen);

      return;
    }

    // Keep scanning, but not for ever. One timer per request: the first miss starts it.
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        callback('');   // no puck within reach; `requestDevice()` rejects and the page says so
      }, timeoutMs);
    }
  });
}

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
  /*
   * HID, serial and USB stay denied outright. Bluetooth is allowed for ONE device: a puck named by
   * `PUCK_NAME_PREFIX`. Electron 43 routes Web Bluetooth's device grant through this handler as
   * well as through `select-bluetooth-device`, so a handler that refused everything would let the
   * picker above succeed and the connection fail immediately afterwards — the kind of
   * half-denial that reads as a radio fault.
   */
  session.setDevicePermissionHandler?.((details) => details?.deviceType === 'bluetooth'
    && typeof details?.device?.deviceName === 'string'
    && details.device.deviceName.startsWith(PUCK_NAME_PREFIX));
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
  PUCK_NAME_PREFIX,
  appEntryUrl,
  isAppUrl,
  guardWebContents,
  denyAllPermissions,
  isPermissionAllowed,
  isTrustedSender,
  chooseBluetoothDevice,
  allowPuckBluetooth,
};
