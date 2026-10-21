// End-to-end automation-API smoke (API.8) on the REAL built app: spawn the Electron shell with
// MIXO_SMOKE=api + a temp MIXO_SMOKE_USERDATA, read <userData>/api/session.json, then drive the
// per-user named pipe (NDJSON JSON-RPC 2.0) from Node: hello -> app.info -> scene.import ->
// scene.list -> validate/readiness/cost -> export.run (stl + 3mf) -> render.thumbnail ->
// project.saveAs -> refused overwrite -> wrong token refused -> confirm gate -> no tmp path in KV
// -> a SECOND process `--job/--result` forwarded to the running app -> clean shutdown.
// Needs `npm run build` first. Exported as runApiSmoke() for tests/electron-smoke.mjs.

import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

const isWin = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connect(pipe) {
  return new Promise((res, rej) => {
    const sock = net.connect(pipe);
    const waiters = new Map();
    let buf = '';
    let closed = false;
    sock.setEncoding('utf8');
    sock.on('data', chunk => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id != null && waiters.has(m.id)) { waiters.get(m.id)(m); waiters.delete(m.id); }
      }
    });
    const onEnd = () => {
      closed = true;
      for (const w of waiters.values()) w({ error: { message: 'socket closed', data: { code: 'CLOSED' } } });
      waiters.clear();
    };
    sock.on('close', onEnd);
    sock.on('error', e => { onEnd(); rej(e); });
    let nextId = 1;
    sock.on('connect', () => res({
      sock,
      get closed() { return closed; },
      call(method, params, timeoutMs = 120000) {
        return new Promise(r => {
          const id = nextId++;
          const t = setTimeout(() => { waiters.delete(id); r({ error: { message: `timeout ${method}`, data: { code: 'TIMEOUT' } } }); }, timeoutMs);
          waiters.set(id, m => { clearTimeout(t); r(m); });
          sock.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        });
      },
    }));
  });
}

const errCode = m => m?.error?.data?.code ?? m?.error?.code ?? null;

export async function runApiSmoke({ bin, label = 'api' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'mixo-apismoke-'));
  const userData = join(root, 'userData');
  const outDir = join(root, 'exports');
  mkdirSync(outDir);
  const fx = resolve('tests', 'fixtures');
  const a = join(root, 'tetra.glb');
  const b = join(root, 'quad.3mf');
  copyFileSync(join(fx, 'open-tetra.glb'), a);
  copyFileSync(join(fx, 'prusa-tetra.3mf'), b);
  const rootName = root.split(/[\\/]/).pop();
  const fails = [];
  let child = null;
  let log = '';
  let t0 = Date.now();
  const step = (name, ok, detail = '') => {
    const ms = Date.now() - t0; t0 = Date.now();
    if (!ok) fails.push(`${name}${detail ? `: ${detail}` : ''}`);
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name} (${ms} ms)${!ok && detail ? ` -- ${detail}` : ''}`);
    return ok;
  };
  const sessionFile = join(userData, 'api', 'session.json');
  const electronArgs = ['electron/main.cjs'];
  const env = { ...process.env, MIXO_SMOKE: 'api', MIXO_SMOKE_USERDATA: userData, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' };
  try {
    child = spawn(bin, electronArgs, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: isWin });
    child.stdout.on('data', c => { log += c; });
    child.stderr.on('data', c => { log += c; });
    let exited = null;
    child.on('exit', c => { exited = c ?? 'signal'; });
    const deadline = Date.now() + 40000;
    while (!existsSync(sessionFile) && Date.now() < deadline && exited === null) await sleep(200);
    if (!step('session file appears', existsSync(sessionFile), `exit=${exited}`)) throw new Error('abort');
    const session = JSON.parse(readFileSync(sessionFile, 'utf8'));

    const c = await connect(session.pipe);
    const hello = await c.call('hello', { token: session.token, apiVersion: 1 });
    if (!step('hello', hello.result?.authenticated === true, JSON.stringify(hello.error))) throw new Error('abort');

    // The renderer answers E_BUSY until it has pulled launch args; retry app.info.
    let info;
    for (let i = 0; i < 60; i++) { info = await c.call('app.info', {}); if (errCode(info) !== 'E_BUSY') break; await sleep(500); }
    step('app.info', info.result?.apiVersion === 1 && info.result?.appVersion != null, JSON.stringify(info.result ?? info.error));

    const imp = await c.call('scene.import', { files: [a, b] });
    step('scene.import x2', !!imp.result, JSON.stringify(imp.error));
    const list = await c.call('scene.list', {});
    const objs = list.result?.objects ?? [];
    const sizeOk = objs.every(o => Array.isArray(o.bounds_mm?.size) && o.bounds_mm.size.length === 3 && o.bounds_mm.size.every(v => v > 0));
    step('scene.list 2 objects, bounds > 0', objs.length === 2 && sizeOk, JSON.stringify((list.result?.objects ?? []).map(o => ({ k: o.kind, n: o.name, s: o.bounds_mm?.size }))));

    for (const [m, p] of [['validate.run', {}], ['readiness.get', {}], ['cost.quote', {}]]) {
      const r = await c.call(m, p);
      step(m, !!r.result && !r.error, JSON.stringify(r.error));
    }

    const ex = await c.call('export.run', { formats: ['stl', '3mf'], outDir, options: { acknowledgeWarnings: true } });
    const files = existsSync(outDir) ? readdirSync(outDir) : [];
    step('export.run stl+3mf', !!ex.result && files.some(f => /\.stl$/i.test(f)) && files.some(f => /\.3mf$/i.test(f)), `${JSON.stringify(ex.error)} files=${files.join(',')}`);
    const stl = files.find(f => /\.stl$/i.test(f));
    const mf = files.find(f => /\.3mf$/i.test(f));
    if (stl) {
      const buf = readFileSync(join(outDir, stl));
      let tris = 0;
      if (buf.subarray(0, 5).toString('latin1') === 'solid' && /facet normal/.test(buf.subarray(0, 400).toString('latin1'))) {
        tris = (buf.toString('latin1').match(/facet normal/g) ?? []).length;
      } else if (buf.length >= 84) tris = buf.readUInt32LE(80);
      step('STL has triangles', tris > 0, `tris=${tris}`);
    }
    if (mf) {
      const zip = await JSZip.loadAsync(readFileSync(join(outDir, mf)));
      step('3MF contains 3D/3dmodel.model', !!zip.file('3D/3dmodel.model'));
    }

    const png = join(root, 'thumb.png');
    const th = await c.call('render.thumbnail', { outFile: png });
    const sig = existsSync(png) ? readFileSync(png).subarray(0, 8).toString('hex') : '';
    step('render.thumbnail PNG', sig === '89504e470d0a1a0a', `${JSON.stringify(th.error)} ${sig}`);

    const mixo = join(root, 'proj.mixo');
    const sv = await c.call('project.saveAs', { file: mixo });
    let text = ''; let doc = null;
    try { text = readFileSync(mixo, 'utf8'); doc = JSON.parse(text); } catch { /* checked below */ }
    step('project.saveAs parses, no tmp path', !!doc && !text.includes(rootName), JSON.stringify(sv.error));

    // Output names derive from the project name, so the first export after saveAs writes a new file;
    // repeating the identical call must then be refused (no overwrite without overwrite:true).
    const expParams = { formats: ['stl'], outDir, options: { acknowledgeWarnings: true } };
    await c.call('export.run', expParams);
    const again = await c.call('export.run', expParams);
    step('export into same dir refused (E_PATH_REJECTED)', errCode(again) === 'E_PATH_REJECTED', `code=${errCode(again)} ${JSON.stringify(again.result ?? '').slice(0, 120)}`);

    let refused = false;
    try {
      const bad = await connect(session.pipe);
      const r = await bad.call('hello', { token: 'x'.repeat(64), apiVersion: 1 }, 5000);
      await sleep(300);
      refused = !!r.error && !r.result && bad.closed;
      bad.sock.destroy();
    } catch { refused = true; }
    step('wrong token refused + closed', refused);

    const rm = await c.call('scene.remove', { ids: objs.map(o => o.id) });
    step('scene.remove without confirm', errCode(rm) === 'E_CONFIRM_REQUIRED', `code=${errCode(rm)}`);

    const kvFile = join(userData, 'mixo-kv.json');
    const kv = existsSync(kvFile) ? readFileSync(kvFile, 'utf8') : '';
    const st = JSON.stringify((await c.call('project.info', {})).result ?? {});
    step('no tmp path in KV / project.info', !kv.includes(rootName) && !st.includes(rootName));

    // second process: --job forwarded to the running app
    const job = join(root, 'job.json');
    const res = join(root, 'r.json');
    writeFileSync(job, JSON.stringify({ apiVersion: 1, steps: [{ method: 'app.info' }, { method: 'scene.list' }] }));
    const tj = Date.now();
    const jobChild = spawn(bin, [...electronArgs, '--job', job, '--result', res], { env, stdio: 'ignore', shell: isWin });
    const jobCode = await new Promise(r => {
      const t = setTimeout(() => { jobChild.kill(); r('timeout'); }, 20000);
      jobChild.on('exit', code => { clearTimeout(t); r(code); });
    });
    let rj = null;
    try { rj = JSON.parse(readFileSync(res, 'utf8')); } catch { /* below */ }
    const listed = rj?.steps?.[1]?.result?.objects?.length;
    step(`--job forwarded (exit ${jobCode}, ${Date.now() - tj} ms)`, jobCode === 0 && rj?.ok === true && listed === 2, `objects=${listed} ${JSON.stringify(rj).slice(0, 300)}`);

    // clean shutdown: graceful close (no /F) so will-quit removes the session file
    c.sock.destroy();
    // A graceful taskkill posts WM_CLOSE; Windows occasionally drops it (the
    // run then "did not exit" with nothing wrong in the app). Re-send every
    // 3 s, still never /F, so will-quit runs and removes the session file.
    const closeAttempts = [];
    const askToClose = () => {
      if (isWin) {
        const r = spawnSync('taskkill', ['/PID', String(session.pid ?? child.pid)], { encoding: 'utf8' });
        closeAttempts.push(`${r.status}:${(r.stdout + r.stderr).trim().replace(/\s+/g, ' ').slice(0, 120)}`);
      } else { child.kill('SIGTERM'); closeAttempts.push('SIGTERM'); }
    };
    askToClose();
    const sd = Date.now() + 15000;
    let nextAsk = Date.now() + 3000;
    while (exited === null && Date.now() < sd) {
      await sleep(200);
      if (exited === null && Date.now() >= nextAsk) { askToClose(); nextAsk = Date.now() + 3000; }
    }
    step(`app exits cleanly (close attempts: ${closeAttempts.length})`, exited !== null, `did not exit; taskkill: ${closeAttempts.join(' | ')}`);
    if (closeAttempts.length > 1) console.log(`MIXO_SMOKE: graceful close needed ${closeAttempts.length} attempts: ${closeAttempts.join(' | ')}`);
    step('session.json removed', !existsSync(sessionFile));
  } catch (e) {
    if (e.message !== 'abort') fails.push(`exception: ${e.message}`);
  } finally {
    if (child && child.exitCode === null) {
      try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* gone */ }
    }
    await sleep(300);
    try { rmSync(root, { recursive: true, force: true }); } catch { /* temp */ }
  }
  if (fails.length) {
    console.error(`FAIL electron smoke (${label}):\n  ${fails.join('\n  ')}\n--- app log tail ---\n${log.slice(-1500)}`);
    return false;
  }
  console.log(`PASS electron desktop smoke — ${label}`);
  return true;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const bin = join('node_modules', '.bin', isWin ? 'electron.cmd' : 'electron');
  process.exit(await runApiSmoke({ bin }) ? 0 : 1);
}
