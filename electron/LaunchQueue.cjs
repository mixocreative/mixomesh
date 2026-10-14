'use strict';
// Launch batches (plan LI.2, decisions D1/D5). Pure: no Electron import, deps injected.
// `buildLaunchBatch` turns parsed argv into the renderer batch
//   { id, items:[{kind:'project'|'import', ref, name}], library:{ref,name}|null, errors:[{name, reason}] }
// where `ref` is an opaque registry token and `name` a basename — an absolute path never
// appears anywhere in the batch (errors use basenames only). `createLaunchQueue` holds
// batches until the renderer pulls (ready flag), then lets later batches be pushed.

const path = require('node:path').win32;
const { MAX_LAUNCH_OPENS } = require('./LaunchArgs.cjs');

const MAX_PENDING_BATCHES = 16;
const baseName = raw => path.basename(String(raw).replace(/\0/g, '')) || '(empty)';

/**
 * @param {{opens:string[], library:string|null, ignored:string[], truncated:number}} parsed parseLaunchArgv result
 * @param {{
 *   validate: (raw:string, kind:'file'|'directory')=>Promise<{ok:true,absolutePath:string,name:string,ext:string}|{ok:false,name:string,reason:string}>,
 *   registerFile: (absolutePath:string, name:string, opts:{writable?:boolean})=>{ref:string,name:string},
 *   registerMount: (absolutePath:string, name:string)=>{ref:string,name:string},
 *   id: string,
 * }} deps
 */
async function buildLaunchBatch(parsed, { validate, registerFile, registerMount, id }) {
  const items = [];
  const errors = [];
  let library = null;
  const guarded = async (raw, kind) => {
    try { return await validate(raw, kind); }
    catch { return { ok: false, name: baseName(raw), reason: 'could not be checked' }; }
  };

  for (const raw of parsed?.opens ?? []) {
    const v = await guarded(raw, 'file');
    if (!v.ok) { errors.push({ name: v.name, reason: v.reason }); continue; }
    try {
      if (v.ext === 'mixo') {
        // Project: writable token so Save writes back to the same file.
        const r = registerFile(v.absolutePath, v.name, { writable: true });
        items.push({ kind: 'project', ref: r.ref, name: r.name });
      } else {
        // Import: read-only token (same as a dropped file).
        const r = registerFile(v.absolutePath, v.name, {});
        items.push({ kind: 'import', ref: r.ref, name: r.name });
      }
    } catch { errors.push({ name: v.name, reason: 'could not be registered' }); }
  }

  if (parsed?.library) {
    const v = await guarded(parsed.library, 'directory');
    if (!v.ok) errors.push({ name: v.name, reason: v.reason });
    else {
      try {
        const r = registerMount(v.absolutePath, v.name);
        library = { ref: r.ref, name: r.name };
      } catch { errors.push({ name: v.name, reason: 'could not be registered' }); }
    }
  }

  for (const a of parsed?.ignored ?? []) {
    if (typeof a === 'string' && !a.startsWith('-')) errors.push({ name: baseName(a), reason: 'unsupported file type' });
  }
  if (parsed?.truncated > 0) {
    errors.push({ name: '', reason: `only the first ${MAX_LAUNCH_OPENS} files were opened (${parsed.truncated} skipped)` });
  }
  return { id, items, library, errors };
}

/** Merge queued batches into one: items/errors concatenated in order, last library wins. */
function mergeBatches(batches, id) {
  const merged = { id, items: [], library: null, errors: [] };
  for (const b of batches) {
    merged.items.push(...b.items);
    if (b.library) merged.library = b.library;
    merged.errors.push(...b.errors);
  }
  return merged;
}

/**
 * Per-window queue. `pull()` (renderer's launch:pull) returns every queued batch merged
 * into ONE batch (or null) and flips ready. `enqueue(batch)` returns the batch to push now
 * when ready, otherwise stores it (bounded) and returns null. `reset()` (did-start-loading)
 * clears ready so a reloading renderer never loses a batch.
 */
function createLaunchQueue({ maxPending = MAX_PENDING_BATCHES } = {}) {
  let pending = [];
  let ready = false;
  let seq = 0;
  return {
    nextId: () => `launch-${Date.now().toString(36)}-${++seq}`,
    isReady: () => ready,
    reset() { ready = false; },
    enqueue(batch) {
      if (ready) return batch;
      if (pending.length >= maxPending) { console.warn('launch: queue full, batch dropped'); return null; }
      pending.push(batch);
      return null;
    },
    pull() {
      ready = true;
      if (!pending.length) return null;
      const taken = pending;
      pending = [];
      return taken.length === 1 ? taken[0] : mergeBatches(taken, taken[taken.length - 1].id);
    },
  };
}

module.exports = { buildLaunchBatch, createLaunchQueue, mergeBatches, MAX_PENDING_BATCHES };
