// Task 6.1 (Decision 19): Electron hardening + Content-Security-Policy, checked
// statically and through the pure predicates in electron/WindowSecurity.cjs.
// The live counterpart is `npm run test:electron` (MIXO_SMOKE=1 security probe).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const {
  SECURE_WEB_PREFERENCES, appEntryUrl, isAppUrl, guardWebContents, denyAllPermissions,
  isPermissionAllowed, isTrustedSender,
} = require('../electron/WindowSecurity.cjs');

const mainSource = readFileSync(new URL('../electron/main.cjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');   // line-ending agnostic (Windows checkouts)
const preloadSource = readFileSync(new URL('../electron/preload.cjs', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const indexHtml = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// The exact policy (index.html meta). Changing it means updating BLUEPRINT §11
// "Electron security" with the reason for every added source.
const EXPECTED_CSP = {
  'default-src': ["'self'"],
  'script-src': ["'self'", "'wasm-unsafe-eval'", "'unsafe-eval'"],
  'style-src': ["'self'"],
  'style-src-attr': ["'unsafe-inline'"],
  'img-src': ["'self'", 'data:', 'blob:'],
  'connect-src': ["'self'", 'data:', 'blob:'],
  'worker-src': ["'self'", 'blob:'],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'none'"],
};

let cases = 0;
async function check(name, fn) {
  try { await fn(); cases++; } catch (err) { err.message = `${name}: ${err.message}`; throw err; }
}

await check('webPreferences: sandbox + contextIsolation, no Node, no webview', () => {
  assert.equal(SECURE_WEB_PREFERENCES.sandbox, true);
  assert.equal(SECURE_WEB_PREFERENCES.contextIsolation, true);
  assert.equal(SECURE_WEB_PREFERENCES.nodeIntegration, false);
  assert.equal(SECURE_WEB_PREFERENCES.webviewTag, false);
  assert.equal(SECURE_WEB_PREFERENCES.webSecurity, true);
  assert.equal(SECURE_WEB_PREFERENCES.allowRunningInsecureContent, false);
  assert.ok(Object.isFrozen(SECURE_WEB_PREFERENCES));
  assert.match(mainSource, /webPreferences:\s*\{\s*\.\.\.SECURE_WEB_PREFERENCES,\s*preload:/);
  assert.doesNotMatch(mainSource, /sandbox:\s*false|nodeIntegration:\s*true|contextIsolation:\s*false|webSecurity:\s*false/);
});

await check('main wires every guard: navigation, window-open, permissions, IPC sender', () => {
  assert.match(mainSource, /app\.on\('web-contents-created'[\s\S]*?guardWebContents\(contents, ENTRY_URL/);
  assert.match(mainSource, /denyAllPermissions\(session\.defaultSession\)/);
  // ipcMain.handle appears exactly once — inside the sender-checking `handle` wrapper.
  assert.equal(mainSource.match(/ipcMain\.handle\(/g)?.length, 1);
  assert.match(mainSource, /function handle\(channel, fn\)[\s\S]*?isTrustedSender\(event, ENTRY_URL\)/);
  assert.match(mainSource, /ipcMain\.on\('app:close-response', \(event, result\) => \{\s*if \(!isTrustedSender\(event, ENTRY_URL\)\) return;/);
  assert.equal(mainSource.match(/ipcMain\.on\(/g)?.length, 1, 'every ipcMain.on listener checks its sender');
});

await check('preload stays sandbox-compatible: requires only electron', () => {
  const requires = [...preloadSource.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(m => m[1]);
  assert.deepEqual(requires, ['electron']);
  for (const api of ['contextBridge', 'ipcRenderer', 'webUtils']) assert.match(preloadSource, new RegExp(`\\b${api}\\b`));
});

await check('isAppUrl: built app = exactly dist/index.html; dev = the dev server origin', () => {
  const indexPath = process.platform === 'win32' ? 'C:\\App\\dist\\index.html' : '/app/dist/index.html';
  const fileEntry = appEntryUrl({ indexPath });
  assert.equal(fileEntry, pathToFileURL(indexPath).href);
  assert.equal(isAppUrl(fileEntry, fileEntry), true);
  assert.equal(isAppUrl(`${fileEntry}?x=1#frag`, fileEntry), true, 'query/hash ignored');
  if (process.platform === 'win32') assert.equal(isAppUrl('file:///c:/app/DIST/index.html', fileEntry), true, 'win32 case-insensitive');
  for (const other of [
    pathToFileURL(indexPath.replace('index.html', 'other.html')).href,
    pathToFileURL(indexPath.replace('dist', 'evil')).href,
    'file:///C:/Windows/System32/drivers/etc/hosts',
    'https://example.com/', 'http://127.0.0.1:5173/', 'javascript:alert(1)', 'data:text/html,hi',
    'about:blank', '', 'not a url', null,
  ]) assert.equal(isAppUrl(other, fileEntry), false, String(other));

  const devEntry = appEntryUrl({ devUrl: 'http://127.0.0.1:5173', indexPath });
  assert.equal(isAppUrl('http://127.0.0.1:5173/', devEntry), true);
  assert.equal(isAppUrl('http://127.0.0.1:5173/index.html?reload', devEntry), true);
  for (const other of ['http://127.0.0.1:5174/', 'http://localhost:5173/', 'https://127.0.0.1:5173/',
    'http://127.0.0.1.evil.com:5173/', fileEntry, 'ws://127.0.0.1:5173/']) {
    assert.equal(isAppUrl(other, devEntry), false, other);
  }
  assert.equal(isAppUrl('http://x/', 'not a url'), false);
});

await check('guardWebContents: foreign navigation/redirect cancelled, popups + webviews denied', () => {
  const entry = 'http://127.0.0.1:5173/';
  const handlers = {};
  let openHandler = null;
  const contents = {
    on: (name, fn) => { handlers[name] = fn; },
    setWindowOpenHandler: fn => { openHandler = fn; },
  };
  const blocked = [];
  guardWebContents(contents, entry, { onBlocked: (kind, url) => blocked.push(`${kind}:${url}`) });
  const nav = (name, url) => { let prevented = false; handlers[name]({ preventDefault: () => { prevented = true; } }, url); return prevented; };
  assert.equal(nav('will-navigate', 'https://evil.example/'), true);
  assert.equal(nav('will-navigate', 'file:///C:/x.html'), true);
  assert.equal(nav('will-navigate', 'http://127.0.0.1:5173/index.html'), false, 'own document may reload');
  assert.equal(nav('will-redirect', 'https://evil.example/'), true);
  let webviewPrevented = false;
  handlers['will-attach-webview']({ preventDefault: () => { webviewPrevented = true; } });
  assert.equal(webviewPrevented, true);
  assert.deepEqual(openHandler({ url: 'https://example.com/' }), { action: 'deny' });
  assert.deepEqual(openHandler({ url: entry }), { action: 'deny' }, 'even the app URL never opens a second window');
  assert.ok(blocked.includes('navigate:https://evil.example/') && blocked.includes('window-open:https://example.com/'));
  // A throwing reporter never weakens the guard.
  guardWebContents(contents, entry, { onBlocked: () => { throw new Error('boom'); } });
  assert.equal(nav('will-navigate', 'https://evil.example/'), true);
});

await check('permissions: deny-all except clipboard write', () => {
  let request = null;
  let checkFn = null;
  let device = null;
  denyAllPermissions({
    setPermissionRequestHandler: fn => { request = fn; },
    setPermissionCheckHandler: fn => { checkFn = fn; },
    setDevicePermissionHandler: fn => { device = fn; },
  });
  const ask = permission => { let answer = null; request({}, permission, v => { answer = v; }); return answer; };
  for (const p of ['media', 'geolocation', 'notifications', 'openExternal', 'fullscreen', 'clipboard-read',
    'pointerLock', 'midi', 'hid', 'serial', 'usb', 'fileSystem', 'display-capture', 'unknown']) {
    assert.equal(ask(p), false, p);
    assert.equal(checkFn({}, p), false, p);
  }
  assert.equal(ask('clipboard-sanitized-write'), true);
  assert.equal(checkFn({}, 'clipboard-sanitized-write'), true);
  assert.equal(isPermissionAllowed('clipboard-sanitized-write'), true);
  assert.equal(device(), false);
});

await check('isTrustedSender: only the app top frame', () => {
  const entry = 'http://127.0.0.1:5173/';
  assert.equal(isTrustedSender({ senderFrame: { url: 'http://127.0.0.1:5173/index.html', parent: null } }, entry), true);
  assert.equal(isTrustedSender({ senderFrame: { url: 'http://127.0.0.1:5173/', parent: {} } }, entry), false, 'child frame');
  assert.equal(isTrustedSender({ senderFrame: { url: 'https://evil.example/', parent: null } }, entry), false);
  assert.equal(isTrustedSender({ senderFrame: null }, entry), false, 'destroyed frame');
  assert.equal(isTrustedSender({}, entry), false);
  assert.equal(isTrustedSender(null, entry), false);
});

function parseCsp(html) {
  const metas = [...html.matchAll(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*>/gi)];
  assert.equal(metas.length, 1, 'exactly one CSP meta tag');
  const map = {};
  for (const part of metas[0][1].split(';').map(p => p.trim()).filter(Boolean)) {
    const [name, ...sources] = part.split(/\s+/);
    assert.equal(map[name], undefined, `duplicate directive ${name}`);
    map[name] = sources;
  }
  return map;
}

await check('CSP meta: the exact policy, no inline script, Decision 19 baseline', () => {
  const csp = parseCsp(indexHtml);
  assert.deepEqual(csp, EXPECTED_CSP);
  assert.equal(csp['script-src'].includes("'unsafe-inline'"), false);
  assert.equal((csp['style-src'] ?? []).includes("'unsafe-inline'"), false, 'inline <style> elements stay blocked');
  // Decision 19 baseline directives are all present verbatim.
  assert.deepEqual(csp['default-src'], ["'self'"]);
  for (const s of ["'self'", 'data:', 'blob:']) assert.ok(csp['img-src'].includes(s));
  for (const s of ["'self'", 'blob:']) assert.ok(csp['worker-src'].includes(s));
  // The meta must precede every script/stylesheet so it governs them.
  const metaAt = indexHtml.search(/<meta\s+http-equiv="Content-Security-Policy"/i);
  const firstResource = Math.min(...['<script', '<link rel="stylesheet"'].map(t => indexHtml.indexOf(t)).filter(i => i >= 0));
  assert.ok(metaAt >= 0 && metaAt < firstResource, 'CSP meta comes before any script or stylesheet');
});

await check('index.html: no inline scripts or event-handler attributes', () => {
  const scripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length >= 1);
  for (const [, attrs, body] of scripts) {
    assert.match(attrs, /\bsrc="[^"]+"/, `script without src: ${attrs}`);
    assert.match(attrs, /\btype="module"/);
    assert.equal(body.trim(), '', 'script tags carry no inline code');
  }
  assert.doesNotMatch(indexHtml, /\son[a-z]+\s*=\s*["']/i, 'no inline on* handlers');
  assert.doesNotMatch(indexHtml, /javascript:/i);
});

await check('installer: registry keys under SHELL_CONTEXT + .mixo association wired', () => {
  const nsh = readFileSync(new URL('../electron/installer.nsh', import.meta.url), 'utf8');
  const yml = readFileSync(new URL('../electron-builder.yml', import.meta.url), 'utf8');
  const iAt = nsh.indexOf('!macro customInstall');
  const uAt = nsh.indexOf('!macro customUnInstall');
  assert.ok(iAt >= 0 && uAt > iAt, 'customInstall then customUnInstall macros present');
  const install = nsh.slice(iAt, uAt);
  const uninstall = nsh.slice(uAt);
  const D = '$';
  const BS = '\\';
  const exe = `${D}{APP_EXECUTABLE_FILENAME}`;
  const appPaths = String.raw`Software\Microsoft\Windows\CurrentVersion\App Paths${BS}${exe}`;
  for (const line of [
    String.raw`WriteRegStr SHELL_CONTEXT "${appPaths}" "" "${D}INSTDIR${BS}${exe}"`,
    String.raw`WriteRegStr SHELL_CONTEXT "${appPaths}" "Path" "${D}INSTDIR"`,
    String.raw`WriteRegStr SHELL_CONTEXT "Software\MIXOMESH" "InstallLocation" "${D}INSTDIR"`,
    String.raw`WriteRegStr SHELL_CONTEXT "Software\MIXOMESH" "Version" "${D}{VERSION}"`,
  ]) assert.ok(install.includes(line), `customInstall lacks: ${line}`);
  for (const line of [
    String.raw`DeleteRegKey SHELL_CONTEXT "${appPaths}"`,
    String.raw`DeleteRegKey SHELL_CONTEXT "Software\MIXOMESH"`,
  ]) assert.ok(uninstall.includes(line), `customUnInstall lacks: ${line}`);
  assert.doesNotMatch(nsh, /HKLM|HKCU|HKEY_/, 'only SHELL_CONTEXT, never a hard-coded hive');
  assert.match(yml, /^\s+include:\s*electron\/installer\.nsh\s*$/m);
  assert.match(yml, /fileAssociations:\s*\r?\n\s*- ext:\s*mixo\b/);
});

await check('launch integration: single instance + trusted launch:pull + two-method preload surface', () => {
  assert.match(mainSource, /const _gotLock = app\.requestSingleInstanceLock\(\);\s*if \(!_gotLock\) app\.quit\(\);/);
  assert.match(mainSource, /if \(_gotLock\) app\.whenReady\(\)/, 'a losing instance never opens a window');
  assert.match(mainSource, /\nhandle\('launch:pull', event => /, 'launch:pull goes through the sender-checking handle');
  assert.doesNotMatch(mainSource, /ipcMain\.handle\(\s*['"]launch:/);
  assert.match(mainSource, /app\.on\('second-instance'[\s\S]*?isMinimized\(\)[\s\S]*?win\.restore\(\)[\s\S]*?win\.focus\(\)/);
  assert.match(mainSource, /on\('did-start-loading', \(\) => launchQueue\.reset\(\)\)/);
  // Only the two methods; neither takes a path-like argument into main.
  assert.match(preloadSource, /pullLaunchRequests:\s*\(\)\s*=>\s*ipcRenderer\.invoke\('launch:pull'\)/);
  assert.match(preloadSource, /onLaunchRequests:\s*\(callback\)\s*=>/);
  const launchChannels = [...new Set([...preloadSource.matchAll(/['"](launch:[a-z-]+)['"]/g)].map(m => m[1]))].sort();
  assert.deepEqual(launchChannels, ['launch:pull', 'launch:requests']);
  assert.equal(preloadSource.match(/invoke\('launch:/g)?.length, 1);
  assert.doesNotMatch(preloadSource, /send\(\s*['"]launch:/, 'the renderer cannot send launch requests');
});

await check('automation API: sender-checked channels, five optional preload methods, session file only under userData', () => {
  // Every API channel is registered through the sender-checking handle(); no raw ipcMain use.
  for (const ch of ['api:response', 'api:notify', 'api:setEnabled', 'api:status']) {
    assert.match(mainSource, new RegExp(`\\nhandle\\('${ch}', `), `${ch} via handle()`);
  }
  assert.doesNotMatch(mainSource, /ipcMain\.(handle|on)\(\s*['"]api:/);
  assert.equal(mainSource.match(/ipcMain\.handle\(/g)?.length, 1);
  assert.equal(mainSource.match(/ipcMain\.on\(/g)?.length, 1);
  // Only main -> renderer 'api:request' is sent; the renderer answers only through invoke.
  assert.deepEqual([...new Set([...mainSource.matchAll(/['"](api:[a-zA-Z]+)['"]/g)].map(m => m[1]))].sort(),
    ['api:notify', 'api:request', 'api:response', 'api:setEnabled', 'api:status']);
  // Responses are matched to the webContents that was asked; booleans only for the toggle.
  assert.match(mainSource, /handle\('api:response'[\s\S]*?p\.sender !== event\.sender/);
  assert.match(mainSource, /handle\('api:setEnabled'[\s\S]*?typeof enabled !== 'boolean'/);
  // Reload fails in-flight requests; session file removed on will-quit and exit.
  assert.match(mainSource, /on\('did-start-loading'[\s\S]*?_failApiRequests\('reload'\)/);
  assert.match(mainSource, /app\.on\('will-quit', event => \{\s*_removeApiSessionFile\(\);/);
  assert.match(mainSource, /process\.on\('exit', _removeApiSessionFile\)/);
  // Server is built only on userData, from the injected registry, and starts after createWindow().
  assert.match(mainSource, /userDataDir: app\.getPath\('userData'\)/);
  assert.ok(mainSource.indexOf('createWindow();\n  // API server') > 0, 'API starts after createWindow()');
  assert.doesNotMatch(mainSource, /session\.json/, 'main never builds the session path itself (ApiServer owns it under userData/api)');
  // Preload: exactly these five new methods, mapped to exactly these channels, none takes a path.
  const apiMethods = [...preloadSource.matchAll(/^\s{2}(onApiRequest|respondApi|notifyApi|setApiEnabled|getApiStatus):/gm)].map(m => m[1]);
  assert.deepEqual(apiMethods, ['onApiRequest', 'respondApi', 'notifyApi', 'setApiEnabled', 'getApiStatus']);
  const apiChannels = [...new Set([...preloadSource.matchAll(/['"](api:[a-zA-Z]+)['"]/g)].map(m => m[1]))].sort();
  assert.deepEqual(apiChannels, ['api:notify', 'api:request', 'api:response', 'api:setEnabled', 'api:status']);
  assert.doesNotMatch(preloadSource, /send\(\s*['"]api:/);
  // Optional: the boot gate's required bridge is unchanged.
  const adapter = readFileSync(new URL('../src/core/storage/DesktopStorageAdapter.js', import.meta.url), 'utf8');
  assert.doesNotMatch(adapter.slice(adapter.indexOf('REQUIRED_BRIDGE'), adapter.indexOf('REQUIRED_BRIDGE') + 400), /Api/);
  // The smoke texts other modes depend on are untouched.
  for (const text of ["'MIXO_SMOKE: loaded'", "MIXO_SMOKE: security ${ok ? 'ok' : 'FAIL'}", "'MIXO_SMOKE: saved'", "'MIXO_SMOKE: launched'"]) {
    assert.ok(mainSource.includes(text.replace(/^'|'$/g, '')), text);
  }
});

assert.equal(cases, 12);
