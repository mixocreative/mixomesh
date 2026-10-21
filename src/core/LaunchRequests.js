// LaunchRequests — renderer side of "call MIXOMESH from another app" (LI.4,
// docs/plans/2026-10-15-launch-integration.md D5/D6). Main hands over batches
// `{id, items:[{kind:'project'|'import', ref, name}], library:{ref,name}|null,
// errors:[{name, reason}]}` (refs are opaque tokens, never paths) via the OPTIONAL
// bridge pair `pullLaunchRequests()` / `onLaunchRequests(cb)`. Without them (web,
// OPFS, older preload) `init()` is a no-op.
//
// Order per batch, serial: (1) the project — last `.mixo` wins, extra ones are
// reported as skipped; dirty-confirm lives in `openPicked`, a Cancel there skips
// only the open; (2) the library folder, exactly like the Mount button; (3) imports,
// exactly like a drop. Every problem (main's errors[], skipped files, step failures)
// ends up in ONE toast listing basenames + reasons. A batch that arrives while an
// import / project load is in flight waits (poll, <= 30 s). Batches share one serial
// lane with automation requests (api/ExternalLane.js).

import { storage as defaultStorage } from './storage/StorageAdapter.js';
import { createExternalLane, externalLane } from './api/ExternalLane.js';

export const WAIT_TIMEOUT_MS = 30000;
export const WAIT_POLL_MS = 250;
const ERROR_TOAST_MS = 10000;

const _msg = err => (err instanceof Error ? err.message : String(err));

/**
 * Build a batch runner with injectable deps (tests pass fakes).
 * @param {{
 *   storage: {readFile:(ref:any)=>Promise<any>, pullLaunchRequests?:()=>Promise<any>, onLaunchRequests?:(cb:Function)=>Function},
 *   openProject: (picked:{ref:any,file:any})=>Promise<any>,
 *   mountLibrary: (picked:{ref:any,name:string})=>Promise<any>,
 *   importAssets: (picked:Array<{ref:any,name:string}>)=>Promise<any>,
 *   toast: (message:string, type:string, duration:number)=>any,
 *   t: (key:string, params?:object)=>string,
 *   isBusy: ()=>boolean,
 *   lane?: {run:(task:()=>Promise<any>)=>Promise<any>},
 *   sleep?: (ms:number)=>Promise<void>,
 *   now?: ()=>number,
 *   waitTimeoutMs?: number, pollMs?: number,
 * }} deps
 */
export function createLaunchRunner(deps) {
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
  const pollMs = deps.pollMs ?? WAIT_POLL_MS;
  const seen = new Set();
  const lane = deps.lane ?? createExternalLane();

  /** @returns {Promise<boolean>} false when still busy after the timeout */
  async function _waitIdle() {
    const start = now();
    while (deps.isBusy()) {
      if (now() - start >= timeoutMs) return false;
      await sleep(pollMs);
    }
    return true;
  }

  async function _run(batch) {
    const errors = Array.isArray(batch.errors)
      ? batch.errors.map(e => ({ name: String(e?.name ?? ''), reason: String(e?.reason ?? '') })) : [];
    const items = Array.isArray(batch.items) ? batch.items : [];
    const projects = items.filter(i => i?.kind === 'project');
    const imports = items.filter(i => i?.kind === 'import');
    const fail = (name, err) => errors.push({ name, reason: _msg(err) });

    if (!(await _waitIdle())) {
      deps.toast(deps.t('launch.busy'), 'warning', ERROR_TOAST_MS);
      return;
    }

    if (projects.length) {
      for (const skipped of projects.slice(0, -1)) {
        errors.push({ name: skipped.name, reason: deps.t('launch.skippedExtraProject') });
      }
      const project = projects[projects.length - 1];
      try {
        const file = await deps.storage.readFile(project.ref);
        if (!file) throw new Error(deps.t('launch.unreadable'));
        await deps.openProject({ ref: project.ref, file });   // dirty-confirm inside; Cancel just returns
      } catch (err) { fail(project.name, err); }
    }

    if (batch.library?.ref) {
      try { await deps.mountLibrary({ ref: batch.library.ref, name: batch.library.name }); }
      catch (err) { fail(batch.library.name, err); }
    }

    if (imports.length) {
      // Same shape `storage.pickImportAssets` returns; importPicked reads the bytes itself.
      const picked = imports.map(i => ({ ref: i.ref, name: i.name }));
      try { await deps.importAssets(picked); }
      catch (err) { fail(imports.map(i => i.name).join(', '), err); }
    }

    if (errors.length) {
      const list = errors.map(e => (e.name ? `${e.name}: ${e.reason}` : e.reason)).join('; ');
      deps.toast(deps.t('launch.errors', { count: errors.length, list }), 'warning', ERROR_TOAST_MS);
    }
  }

  /** Queue a batch (serial). Duplicate ids are ignored. Resolves when it finished. */
  function handle(batch) {
    if (!batch || typeof batch !== 'object') return Promise.resolve();
    if (batch.id !== undefined && batch.id !== null) {
      if (seen.has(batch.id)) return Promise.resolve();
      seen.add(batch.id);
    }
    return lane.run(() => _run(batch)).catch(err => {
      deps.toast(deps.t('launch.errors', { count: 1, list: _msg(err) }), 'warning', ERROR_TOAST_MS);
    });
  }

  /** Subscribe to pushed batches, then pull the queued one. No bridge → no-op. */
  async function init() {
    const s = deps.storage;
    if (typeof s.pullLaunchRequests !== 'function' || typeof s.onLaunchRequests !== 'function') return () => {};
    const off = s.onLaunchRequests(b => { handle(b); });
    try { await handle(await s.pullLaunchRequests()); }
    catch (err) { console.warn('[launch] pull failed:', err); }
    return typeof off === 'function' ? off : () => {};
  }

  return { handle, init };
}

let _runner = null;

/** Wire the real deps (lazy UI imports keep this module headless-safe) and start. */
async function init() {
  if (_runner) return;
  const [{ PersistenceManager }, { AssetPanel }, { ViewportDrop }, { Toast }, { t }, { AssetLoader }, { isLoading }] =
    await Promise.all([
      import('./PersistenceManager.js'),
      import('../ui/AssetPanel.js'),
      import('../ui/ViewportDrop.js'),
      import('../ui/Toast.js'),
      import('../i18n/index.js'),
      import('./AssetLoader.js'),
      import('./persist/LoadGate.js'),
    ]);
  _runner = createLaunchRunner({
    storage: defaultStorage,
    openProject: picked => PersistenceManager.openPicked(picked),
    mountLibrary: picked => AssetPanel.mountFromRef(picked),
    importAssets: picked => ViewportDrop.importPicked(picked),
    toast: (m, type, ms) => Toast.show(m, type, ms),
    t,
    isBusy: () => AssetLoader.isImporting() || isLoading(),
    lane: externalLane,
  });
  await _runner.init();
}

export const LaunchRequests = { init, createLaunchRunner };
