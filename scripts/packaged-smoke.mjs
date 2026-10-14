#!/usr/bin/env node
// Packaged-app smoke (plan PB.14). After `npm run dist`, launches the UNPACKED build with
// MIXO_SMOKE=1: main.cjs then runs the same security probe as `npm run test:electron`, from
// inside app.asar, and exits 0 only when
//   * the page booted under the hardened shell, and
//   * publish:describe lists the cults3d platform AND the default `tunnel` file host --
//     which proves defaultLoadCore()'s import() of src/listbridge/index.js (ESM) resolved
//     from app.asar (the one packaging risk).
// Usage: node scripts/packaged-smoke.mjs [path/to/MIXOMESH.exe] [--launch]
//   --launch (LI.6): ALSO a black-box single-instance check. Packaged builds ignore every
//   MIXO_SMOKE mode by design (main.cjs gates them on !app.isPackaged), so there is no
//   in-process probe: start the exe with `--open <fixture>`, then call it a second time
//   with `--open <fixture>` and assert the second process exits 0 within 10 s while the
//   first is still running. It uses the REAL userData (packaged builds honour no override),
//   so it refuses to run if a MIXOMESH.exe is already open.
//   --api (API.8): REDUCED black-box check of the automation pipe. Packaged builds ignore MIXO_SMOKE and
//   honour no userData override, so the full tests/electron-api-smoke.mjs sequence (imports, exports,
//   forwarded --job) is NOT replayed here. Instead: start the exe on the REAL userData (refuses if a
//   MIXOMESH.exe is already open), wait for %APPDATA%/<productName>/api/session.json, then over the
//   named pipe: hello (token) -> app.info (apiVersion 1, appVersion set) -> scene.list (an array) ->
//   a wrong-token connection is refused; finally a graceful close (taskkill without /F) and assert
//   the session file is gone.
//   default: release/win-unpacked/MIXOMESH.exe
// Needs a real desktop session (it opens a window briefly). Owner: run once on a clean
// Windows user profile; SmartScreen only appears for the installer, not this unpacked exe.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import net from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';

const argv = process.argv.slice(2);
const wantLaunch = argv.includes('--launch');
const wantApi = argv.includes('--api');
const exe = resolve(argv.find(a => !a.startsWith('--')) ?? join('release', 'win-unpacked', 'MIXOMESH.exe'));
if (!existsSync(exe)) {
  console.error(`packaged smoke: ${exe} not found. Run \`npm run build && npm run dist\` first.`);
  process.exit(1);
}
const asar = join(dirname(exe), 'resources', 'app.asar');
const cloudflared = join(dirname(exe), 'resources', 'listbridge', 'cloudflared.exe');
console.log(`packaged smoke: ${exe}`);
console.log(`  app.asar present: ${existsSync(asar)}${existsSync(asar) ? ` (${(statSync(asar).size / 1048576).toFixed(1)} MB)` : ''}`);
console.log(`  bundled cloudflared: ${existsSync(cloudflared)} (must be false: downloaded on first use instead)`);
if (existsSync(cloudflared)) {
  console.error('FAIL packaged smoke: cloudflared must NOT be bundled in resources/listbridge/');
  process.exit(1);
}

const out = [];
const child = spawn(exe, [], { env: { ...process.env, MIXO_SMOKE: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', c => out.push(String(c)));
child.stderr.on('data', c => out.push(String(c)));
const timer = setTimeout(() => { child.kill(); console.error('FAIL packaged smoke: timeout'); process.exit(1); }, 90000);
child.on('error', err => { clearTimeout(timer); console.error('FAIL packaged smoke:', err.message); process.exit(1); });
child.on('exit', code => {
  clearTimeout(timer);
  const log = out.join('');
  const line = log.split(/\r?\n/).find(l => l.includes('MIXO_SMOKE: security')) ?? '';
  if (line) console.log(line);
  if (code === 0) {
    console.log('PASS packaged smoke: booted from app.asar; publish:describe lists cults3d + tunnel');
    if (wantLaunch || wantApi) {
      (async () => {
        const launchOk = wantLaunch ? await runLaunchCheck() : true;
        const apiOk = launchOk && wantApi ? await runApiCheck() : launchOk;
        process.exit(apiOk ? 0 : 1);
      })();
      return;
    }
    process.exit(0);
  }
  console.error(`FAIL packaged smoke: exit ${code}${line ? '' : ' (no probe line captured; exit code is authoritative)'}\n${log.slice(-1500)}`);
  process.exit(1);
});

// Black-box single-instance check (see header). First instance stays up; the second must
// forward its argv and exit 0 quickly.
async function runLaunchCheck() {
  const name = basename(exe);
  const running = () => spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { encoding: 'utf8' }).stdout.includes(name);
  if (running()) { console.error(`FAIL packaged launch check: ${name} is already running (it would own the lock); close it first`); return false; }
  const fixture = resolve('tests', 'fixtures', 'open-tetra.glb');
  const first = spawn(exe, ['--open', fixture], { stdio: 'ignore' });
  let firstExit = null;
  first.on('exit', c => { firstExit = c; });
  await new Promise(r => setTimeout(r, 6000));
  if (firstExit !== null) { console.error(`FAIL packaged launch check: first instance exited early (${firstExit})`); return false; }
  const t0 = Date.now();
  const second = spawn(exe, ['--open', fixture], { stdio: 'ignore' });
  const code = await new Promise(res => {
    const timer = setTimeout(() => { second.kill(); res('timeout'); }, 10000);
    second.on('exit', c => { clearTimeout(timer); res(c); });
    second.on('error', () => { clearTimeout(timer); res('error'); });
  });
  const ms = Date.now() - t0;
  await new Promise(r => setTimeout(r, 500));
  const alive = firstExit === null;
  spawnSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { stdio: 'ignore' });
  if (code !== 0 || !alive) { console.error(`FAIL packaged launch check: second exit=${code} (${ms} ms), first alive=${alive}`); return false; }
  console.log(`PASS packaged launch check: second instance exited 0 in ${ms} ms, first still running`);
  return true;
}

// Reduced black-box automation-API check (see header, --api).
async function runApiCheck() {
  const name = basename(exe);
  const running = () => spawnSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/NH'], { encoding: 'utf8' }).stdout.includes(name);
  if (running()) { console.error(`FAIL packaged api check: ${name} is already running; close it first`); return false; }
  const productName = 'MIXOMESH'; // electron-builder.yml productName (= %APPDATA% folder)
  const sessionFile = join(process.env.APPDATA ?? '', productName, 'api', 'session.json');
  if (existsSync(sessionFile)) { try { (await import('node:fs')).unlinkSync(sessionFile); } catch { /* stale */ } }
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const first = spawn(exe, [], { stdio: 'ignore' });
  let firstExit = null;
  first.on('exit', c => { firstExit = c; });
  const fails = [];
  let session = null;
  try {
    const t0 = Date.now();
    while (!existsSync(sessionFile) && Date.now() - t0 < 40000 && firstExit === null) await sleep(250);
    if (!existsSync(sessionFile)) { fails.push(`no session.json at ${sessionFile} (exit=${firstExit})`); return false; }
    session = JSON.parse(readFileSync(sessionFile, 'utf8'));
    const open = () => new Promise((res, rej) => {
      const sock = net.connect(session.pipe); let buf = ''; const waiters = new Map(); let id = 1; let closed = false;
      sock.setEncoding('utf8');
      sock.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const m = JSON.parse(l); waiters.get(m.id)?.(m); } catch { /* ignore */ } } });
      sock.on('close', () => { closed = true; for (const w of waiters.values()) w({ error: { message: 'closed' } }); });
      sock.on('error', rej);
      sock.on('connect', () => res({ sock, get closed() { return closed; }, call: (method, params) => new Promise(r => {
        const n = id++; const t = setTimeout(() => r({ error: { message: `timeout ${method}` } }), 30000);
        waiters.set(n, m => { clearTimeout(t); r(m); }); sock.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
      }) }));
    });
    const c = await open();
    const hello = await c.call('hello', { token: session.token, apiVersion: 1 });
    if (hello.result?.authenticated !== true) fails.push(`hello: ${JSON.stringify(hello.error)}`);
    let info;
    for (let i = 0; i < 60; i++) { info = await c.call('app.info', {}); if (info.error?.data?.code !== 'E_BUSY') break; await sleep(500); }
    if (info.result?.apiVersion !== 1 || info.result?.appVersion == null) fails.push(`app.info: ${JSON.stringify(info.result ?? info.error)}`);
    const list = await c.call('scene.list', {});
    if (!Array.isArray(list.result?.objects)) fails.push(`scene.list: ${JSON.stringify(list.error ?? list.result)}`);
    const bad = await open();
    const br = await bad.call('hello', { token: 'x'.repeat(64), apiVersion: 1 });
    await sleep(300);
    if (!br.error || !bad.closed) fails.push('wrong token was not refused/closed');
    c.sock.destroy(); bad.sock.destroy();
  } catch (e) {
    fails.push(`exception: ${e.message}`);
  } finally {
    if (firstExit === null) spawnSync('taskkill', ['/PID', String(session?.pid ?? first.pid)], { stdio: 'ignore' });
    const t1 = Date.now();
    while (firstExit === null && Date.now() - t1 < 15000) await sleep(250);
    if (firstExit === null) { fails.push('app did not close gracefully'); spawnSync('taskkill', ['/PID', String(first.pid), '/T', '/F'], { stdio: 'ignore' }); }
    else if (existsSync(sessionFile)) fails.push('session.json was not removed on exit');
  }
  if (fails.length) { console.error(`FAIL packaged api check:\n  ${fails.join('\n  ')}`); return false; }
  console.log('PASS packaged api check: hello + app.info + scene.list over the pipe, wrong token refused, session removed on exit');
  return true;
}
