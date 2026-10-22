// ApiDispatcher — runtime-agnostic command set of the automation API (ADR 0005, API.2).
// `createDispatcher(deps)` takes EVERY dependency by injection (no app-singleton
// imports here; `AppDispatcherDeps.js` wires the real modules). Only the pure
// ApiErrors / ApiSchema modules are imported.
//
// Contract with the host (Electron main):
//  - Path-typed params arrive as opaque `{ref, name}` tokens, never strings. A string
//    in a path field is refused (E_PATH_REJECTED): main must have converted it. The
//    dispatcher never returns an absolute path either (error text is scrubbed).
//  - Outputs that need files return bytes: export.run -> [{name, bytes}],
//    render.* -> {name, bytes}; main writes them.
//  - dispatch() resolves to the method result or rejects with an apiError object
//    (`{code, message, data:{code:'E_...'}}`), never a bare Error.
//  - A request may carry `params.requestId`. A repeat of that id within
//    REQUEST_ID_WINDOW_MS is answered with the first request's outcome (the
//    same result, or it waits for the first if that is still running) and
//    never runs again; a failed request is forgotten so its retry runs (cia F-08).
//  - Requests run one at a time (serial queue). Each waits for isBusy() to clear
//    (poll, like LaunchRequests) and fails with E_BUSY after busyTimeoutMs.
//    `app.*` and `events.subscribe` are answered at once, outside the queue, so
//    health checks work during a long export.

import { API_VERSION, apiError, isApiError } from './ApiErrors.js';
import { METHODS, EVENT_TYPES, LIMITS, getMethod, methodNames, validateParams, takeRequestId } from './ApiSchema.js';
import { createExternalLane } from './ExternalLane.js';

export const BUSY_TIMEOUT_MS = 30000;
export const BUSY_POLL_MS = 250;
export const EVENTS_PER_SECOND = 50;
export const REQUEST_ID_WINDOW_MS = 10 * 60 * 1000;
export const REQUEST_ID_MAX_REMEMBERED = 256;

const IMMEDIATE = new Set(['app.info', 'app.capabilities', 'app.ping', 'events.subscribe']);
const COST_NUMBER_KEYS = ['pricePerGram', 'supportPricePerGram', 'supportPercent', 'setupFee'];
const EXPORT_OPTION_KEYS = ['acknowledgeWarnings', 'individually'];

const isRef = v => !!v && typeof v === 'object' && !Array.isArray(v)
  && 'ref' in v && v.ref != null && typeof v.name === 'string' && v.name !== '';

/** Replace anything that looks like an absolute path in a message by its basename. */
export function scrubPaths(text) {
  return String(text ?? '').replace(
    /(?:[A-Za-z]:[\\/]|\\\\|\/(?=[\w.-]+\/))[^\s"'<>|*?]*/g,
    m => m.split(/[\\/]/).filter(Boolean).pop() || '',
  );
}

const plain = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const countSeverity = (results, severity) => (results ?? []).filter(r => r?.severity === severity).length;
const slimResults = results => (results ?? []).map(r => ({
  type: r.type, severity: r.severity, message: r.message,
}));

async function toBytes(blobOrBytes) {
  if (blobOrBytes instanceof Uint8Array) return blobOrBytes;
  if (blobOrBytes && typeof blobOrBytes.arrayBuffer === 'function') {
    return new Uint8Array(await blobOrBytes.arrayBuffer());
  }
  throw apiError('E_INTERNAL', 'capture produced no image data');
}

/**
 * @param {object} deps  see AppDispatcherDeps.js for the real wiring; tests pass fakes.
 */
export function createDispatcher(deps) {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const busyTimeoutMs = deps.busyTimeoutMs ?? BUSY_TIMEOUT_MS;
  const busyPollMs = deps.busyPollMs ?? BUSY_POLL_MS;
  const maxEventsPerSec = deps.eventsPerSecond ?? EVENTS_PER_SECOND;
  const supportsRefs = deps.supportsRefs !== false;
  const getState = () => deps.state.getState();

  // ---------- helpers on state ----------
  const objects = () => getState().scene?.objects ?? {};
  const groups = () => getState().scene?.groups ?? {};
  const leadOf = id => {
    const o = objects()[id];
    return o?.logicalObjectId && objects()[o.logicalObjectId] ? o.logicalObjectId : id;
  };
  const partIdsOf = leadId => Object.values(objects())
    .filter(o => o && (o.id === leadId || o.logicalObjectId === leadId)).map(o => o.id);
  const displayedLeads = () => Object.values(objects())
    .filter(o => o && !o.isInternalPart && !o.isGhost);

  /** Validate ids -> canonical selectable ids (object lead or group). E_NOT_FOUND on any miss. */
  function resolveIds(ids) {
    const out = [];
    for (const id of ids) {
      if (objects()[id] && !objects()[id].isGhost) out.push(leadOf(id));
      else if (groups()[id]) out.push(id);
      else throw apiError('E_NOT_FOUND', `no scene object or group with id "${String(id).slice(0, 64)}"`, { id });
    }
    return [...new Set(out)];
  }

  function describeObject(o, includeValidation) {
    const metrics = deps.metrics?.(partIdsOf(o.id)) ?? {};
    const row = {
      id: o.id,
      name: o.name ?? o.id,
      kind: 'object',
      logicalObjectId: o.logicalObjectId ?? o.id,
      collectionId: o.collectionId ?? null,
      bounds_mm: metrics.bounds_mm ?? null,
      triangles: metrics.triangles ?? 0,
    };
    if (includeValidation) {
      const ids = partIdsOf(o.id);
      const cache = ids.map(i => getState().scene?.validation?.[i]).filter(Boolean);
      row.validation = cache.length
        ? {
          checked: true,
          stale: cache.some(c => c.stale),
          errors: cache.reduce((n, c) => n + countSeverity(c.results, 'error'), 0),
          warnings: cache.reduce((n, c) => n + countSeverity(c.results, 'warning'), 0),
        }
        : { checked: false, stale: false, errors: 0, warnings: 0 };
    }
    return row;
  }

  function projectInfo() {
    const p = getState().project ?? {};
    return {
      name: p.name ?? null,
      id: p.id ?? null,
      dirty: !!deps.persistence.isDirty(),
      lastSavedAt: p.lastSavedAt ?? null,
      hasFile: !!deps.persistence.hasSaveTarget?.(),
    };
  }

  // ---------- events ----------
  let subs = [];            // unsubscribe fns
  let subscribedTypes = new Set();
  // Rate window per event type: the subscription set is shared by every pipe client (main
  // filters and caps per client), so one chatty type must not starve the others.
  const windows = new Map();   // type -> { start, count, dropped }

  function emit(type, data) {
    if (!subscribedTypes.has(type) || typeof deps.notify !== 'function') return;
    const t = now();
    let w = windows.get(type);
    if (!w) windows.set(type, w = { start: t, count: 0, dropped: 0 });
    if (t - w.start >= 1000) { w.start = t; w.count = 0; }
    if (w.count >= maxEventsPerSec) { w.dropped++; return; }
    w.count++;
    const payload = { type, data: plain(data) ?? {} };
    if (w.dropped > 0) { payload.dropped = w.dropped; w.dropped = 0; }
    try { deps.notify(payload); } catch { /* a broken sink must not break a command */ }
  }

  const EVENT_SOURCES = {
    objectAdded: [['ASSET_INSTANTIATED', p => {
      const o = objects()[p?.meshId];
      return o && o.isInternalPart ? null : { id: p?.meshId, name: p?.meshName ?? o?.name ?? null };
    }]],
    objectRemoved: [['OBJECT_REMOVED', p => ({ id: p?.id })]],
    selectionChanged: [['SELECTION_CHANGED', p => ({ selectedIds: p?.selectedIds ?? [], activeId: p?.activeId ?? null })]],
    validationDone: [['VALIDATION_COMPLETE', p => ({
      id: p?.meshId ?? null, name: p?.meshName ?? null,
      errors: countSeverity(p?.results, 'error'), warnings: countSeverity(p?.results, 'warning'),
    })]],
    projectOpened: [['PROJECT_LOADED', () => projectInfo()], ['PROJECT_NEW', () => ({ ...projectInfo(), new: true })]],
    projectSaved: [['PROJECT_SAVED', () => {
      // PROJECT_SAVED also fires when undo returns to the saved point and on
      // New; only a moved write generation means bytes reached disk (cia A-05).
      const gen = writeGeneration();
      if (gen !== undefined && gen === lastWriteGen) return null;
      lastWriteGen = gen;
      return projectInfo();
    }]],
  };
  const writeGeneration = () => deps.persistence?.saveGeneration?.();
  let lastWriteGen = writeGeneration();

  function setSubscriptions(types) {
    for (const off of subs) { try { off(); } catch { /* noop */ } }
    subs = [];
    subscribedTypes = new Set(types);
    lastWriteGen = writeGeneration();
    for (const type of types) {
      for (const [evKey, map] of EVENT_SOURCES[type] ?? []) {
        const name = deps.EVENTS?.[evKey];
        if (!name) continue;
        subs.push(deps.state.subscribe(name, payload => {
          let data;
          try { data = map(payload); } catch { return; }
          if (data) emit(type, data);
        }));
      }
    }
  }

  // ---------- queue ----------
  const lane = deps.lane ?? createExternalLane();
  let pending = 0;

  const throwIfCancelled = signal => {
    if (signal?.aborted) throw apiError('E_CANCELLED', 'the request was cancelled before it started');
  };

  async function waitIdle(signal) {
    const start = now();
    while (deps.isBusy?.()) {
      throwIfCancelled(signal);
      if (now() - start >= busyTimeoutMs) {
        throw apiError('E_BUSY', 'MIXOMESH is busy (import, load, save, export, repair or an open dialog in progress); try again later');
      }
      await sleep(busyPollMs);
    }
  }

  function enqueue(task, signal) {
    const run = async () => {
      throwIfCancelled(signal);
      if (pending++ === 0) emit('busy', { busy: true });
      try {
        await waitIdle(signal);
        throwIfCancelled(signal);
        return await task();
      } finally {
        if (--pending === 0) emit('busy', { busy: false });
      }
    };
    return lane.run(run);
  }

  // ---------- param pre-pass: ref tokens ----------
  /**
   * Path params must be `{ref,name}` tokens. Substitute the token's `name` so the
   * schema validator (which expects path strings) can run, then put the tokens back.
   */
  const HOST_ONLY_OUTPUT = { 'export.run': 'outDir', 'render.png': 'outFile', 'render.thumbnail': 'outFile' };
  function validateWithRefs(spec, params) {
    const p = params === undefined || params === null ? {} : params;
    if (typeof p !== 'object' || Array.isArray(p)) return spec.validate(p);
    const tokens = {};
    const shadow = { ...p };
    // Output paths never reach the renderer (main validates + writes them and strips the key),
    // so the schema's required path is satisfied by a placeholder that is dropped again.
    const hostOnly = HOST_ONLY_OUTPUT[spec.name];
    if (hostOnly && !(hostOnly in p)) shadow[hostOnly] = 'host-managed';
    for (const [k, f] of Object.entries(spec.params)) {
      if (!(k in p)) continue;
      const v = p[k];
      if (f.type === 'path') {
        if (typeof v === 'string') throw apiError('E_PATH_REJECTED', `${spec.name}: "${k}" must be resolved by the host (got a raw path)`, { field: k });
        if (!isRef(v)) throw apiError('E_INVALID_PARAMS', `${spec.name}: "${k}" must be a {ref,name} token`, { field: k });
        tokens[k] = v; shadow[k] = v.name;
      } else if (f.type === 'stringArray' && f.item === 'path') {
        if (!Array.isArray(v)) throw apiError('E_INVALID_PARAMS', `${spec.name}: "${k}" must be an array of {ref,name} tokens`, { field: k });
        for (const e of v) {
          if (typeof e === 'string') throw apiError('E_PATH_REJECTED', `${spec.name}: "${k}" entries must be resolved by the host (got a raw path)`, { field: k });
          if (!isRef(e)) throw apiError('E_INVALID_PARAMS', `${spec.name}: "${k}" entries must be {ref,name} tokens`, { field: k });
        }
        tokens[k] = v.map(e => ({ ref: e.ref, name: e.name }));
        shadow[k] = v.map(e => e.name);
      }
    }
    const out = spec.validate(shadow);
    if (hostOnly && !(hostOnly in p)) delete out[hostOnly];
    for (const k of Object.keys(tokens)) out[k] = tokens[k];
    return out;
  }

  // ---------- guards ----------
  function requireConfirm(method, p, why) {
    if (p.confirm !== true) {
      throw apiError('E_CONFIRM_REQUIRED', `${method} ${why}; pass confirm:true to proceed`, { method });
    }
  }
  function guardDirty(method, p) {
    if (deps.persistence.isDirty() && p.confirm !== true) {
      throw apiError('E_DIRTY', `${method}: the open project has unsaved changes; pass confirm:true to discard them`, { method });
    }
  }
  // Discard unsaved work only for a replacement that succeeds: the hidden window cannot answer
  // the dirty dialog, so clear it up front, and mark the work unsaved again if `replace` fails.
  async function replacingProject(replace) {
    const restore = deps.persistence.isDirty() ? deps.persistence.discardChanges() : null;
    try {
      await replace();
    } catch (e) {
      restore?.();
      throw e;
    }
  }

  // ---------- handlers ----------
  const H = {
    'app.info': async () => ({
      name: 'MIXOMESH',
      apiVersion: API_VERSION,
      version: deps.appVersion ?? null,
      runtime: deps.runtime ?? 'unknown',
      busy: !!deps.isBusy?.() || pending > 0,
    }),
    'app.capabilities': async () => ({
      apiVersion: API_VERSION,
      runtime: deps.runtime ?? 'unknown',
      supportsRefs,
      methods: METHODS.map(m => ({ name: m.name, destructive: m.destructive, needsPath: m.needsPath, since: m.since })),
      events: [...EVENT_TYPES],
      limits: { ...LIMITS, eventsPerSecond: maxEventsPerSec, requestIdWindowMs: REQUEST_ID_WINDOW_MS },
    }),
    'app.ping': async () => ({ pong: true, time: now() }),

    'project.new': async p => {
      guardDirty('project.new', p);
      await replacingProject(() => deps.persistence.newProject());
      return projectInfo();
    },
    'project.open': async p => {
      guardDirty('project.open', p);
      let file;
      try { file = await deps.readFile(p.file.ref); } catch { file = null; }
      if (!file) throw apiError('E_NOT_FOUND', `cannot read project "${p.file.name}"`);
      await replacingProject(() => deps.persistence.openPicked({ ref: p.file.ref, file }));
      return projectInfo();
    },
    'project.save': async () => {
      if (!deps.persistence.hasSaveTarget?.()) {
        throw apiError('E_UNSUPPORTED', 'project has no file yet; use project.saveAs');
      }
      const ok = await deps.persistence.save();
      if (ok === false) throw apiError('E_CANCELLED', 'save was cancelled');
      return projectInfo();
    },
    'project.saveAs': async p => {
      // overwrite policy is enforced by the host when it validates the output file.
      const ok = await deps.persistence.saveAs({ ref: p.file.ref, name: p.file.name });
      if (ok === false) throw apiError('E_CANCELLED', 'save was cancelled');
      return projectInfo();
    },
    'project.info': async () => projectInfo(),

    'scene.list': async p => ({
      objects: displayedLeads().map(o => describeObject(o, p.includeValidation === true)),
    }),
    'scene.get': async p => {
      const [id] = resolveIds([p.id]);
      const o = objects()[id];
      if (o) return describeObject(o, p.includeValidation === true);
      const g = groups()[id];
      return { id, name: g?.name ?? id, kind: 'group', childIds: plain(g?.childIds ?? g?.children ?? []) };
    },
    'scene.import': async (p, signal) => {
      const before = new Set(Object.keys(objects()));
      await deps.importPicked(p.files.map(f => ({ ref: f.ref, name: f.name })), { signal });
      throwIfCancelled(signal);
      const added = displayedLeads().filter(o => !before.has(o.id));
      if (!added.length) {
        throw apiError('E_INTERNAL', 'import produced no objects (unsupported or unreadable file)');
      }
      return { added: added.map(o => describeObject(o, false)) };
    },
    'scene.remove': async p => {
      requireConfirm('scene.remove', p, 'deletes objects');
      const ids = resolveIds(p.ids);
      deps.history.push(deps.commands.remove(ids));   // DeleteCommand: undoable
      return { removed: ids, undoable: true };
    },
    'scene.select': async p => {
      const ids = resolveIds(p.ids);
      const next = p.additive === true
        ? [...new Set([...deps.selection.getSelectedIds(), ...ids])] : ids;
      deps.selection.set(next, ids.length ? ids[ids.length - 1] : null);
      return { selectedIds: [...deps.selection.getSelectedIds()] };
    },
    'scene.transform': async p => {
      const [id] = resolveIds([p.id]);
      const cmd = deps.commands.transform(id, {
        position_mm: p.position_mm, rotation_deg: p.rotation_deg, scale: p.scale,
      });
      if (!cmd) return { id, changed: false };
      deps.history.push(cmd);   // TransformCommand: undoable
      return { id, changed: true, undoable: true };
    },

    'library.mount': async p => {
      await deps.mountLibrary({ ref: p.dir.ref, name: p.dir.name });
      return { mounted: p.dir.name };
    },
    'library.list': async p => {
      const entries = await deps.listLibrary(p.subdir ?? '');
      if (entries == null) throw apiError('E_NOT_FOUND', 'no library folder is mounted');
      return { entries: entries.map(e => ({ name: e.name, kind: e.kind })) };
    },

    'printer.list': async () => ({
      current: deps.printers.currentId(),
      printers: plain(deps.printers.list()),
    }),
    'printer.get': async () => plain(deps.printers.get()),
    'printer.set': async p => {
      if (!deps.printers.exists(p.id)) throw apiError('E_NOT_FOUND', `unknown printer "${p.id.slice(0, 64)}"`, { id: p.id });
      deps.history.push(deps.commands.applyPrinter(p.id));   // ApplyPrinterProfileCommand: undoable
      return plain(deps.printers.get());
    },

    'validate.run': async p => {
      const leads = p.ids ? resolveIds(p.ids) : null;
      const rows = [];
      if (leads) {
        for (const id of leads) rows.push([id, await deps.validator.validateOne(id)]);
      } else {
        for (const [id, results] of await deps.validator.validateAll()) rows.push([id, results]);
      }
      const out = rows.map(([id, results]) => ({
        id, name: objects()[id]?.name ?? id,
        errors: countSeverity(results, 'error'),
        warnings: countSeverity(results, 'warning'),
        results: slimResults(results),
      }));
      return {
        objects: out,
        errors: out.reduce((n, r) => n + r.errors, 0),
        warnings: out.reduce((n, r) => n + r.warnings, 0),
      };
    },
    'repair.run': async p => {
      requireConfirm('repair.run', p, 'modifies geometry');
      const ids = p.ids ? resolveIds(p.ids) : displayedLeads().filter(o => o.isPrintPart).map(o => o.id);
      const sum = async () => {
        let errors = 0; let warnings = 0;
        for (const id of ids) {
          const r = await deps.validator.validateOne(id);
          errors += countSeverity(r, 'error'); warnings += countSeverity(r, 'warning');
        }
        return { errors, warnings };
      };
      const before = await sum();
      const res = await deps.repair.run(ids);
      const after = await sum();
      return {
        before, after,
        repaired: res?.repaired ?? 0,
        holesFilled: res?.holesFilled ?? 0,
        nonManifoldFixed: res?.nmFixed ?? 0,
        failed: (res?.failed ?? []).map(f => ({
          id: f.meshId, name: f.name, error: scrubPaths(f.error?.message ?? f.error),
        })),
        note: 'The repair engine is nondeterministic; re-run validate.run to confirm.',
      };
    },
    'readiness.get': async () => plain(deps.readiness.get({})),
    'cost.quote': async p => {
      const opt = p.options ?? {};
      const known = new Set([...COST_NUMBER_KEYS, 'currency', 'volumeMode', 'materialId', 'selectedOnly']);
      for (const k of Object.keys(opt)) {
        if (!known.has(k)) throw apiError('E_INVALID_PARAMS', `cost.quote: options."${k}" is not a known option`, { field: `options.${k}` });
      }
      for (const k of COST_NUMBER_KEYS) {
        if (k in opt && !(typeof opt[k] === 'number' && Number.isFinite(opt[k]) && opt[k] >= 0)) {
          throw apiError('E_INVALID_PARAMS', `cost.quote: options."${k}" must be a number >= 0`, { field: `options.${k}` });
        }
      }
      if ('volumeMode' in opt && opt.volumeMode !== 'mesh' && opt.volumeMode !== 'bbox') {
        throw apiError('E_INVALID_PARAMS', 'cost.quote: options."volumeMode" must be "mesh" or "bbox"', { field: 'options.volumeMode' });
      }
      const ids = p.ids ? resolveIds(p.ids) : null;
      const base = { ...(getState().cost ?? {}) };
      for (const k of [...COST_NUMBER_KEYS, 'currency', 'volumeMode', 'materialId']) if (k in opt) base[k] = opt[k];
      const material = deps.cost.material(base.materialId) ?? null;
      const contexts = await deps.cost.contexts({ ids, selectedOnly: opt.selectedOnly === true });
      if (!contexts || !contexts.length) throw apiError('E_NOT_FOUND', 'no printable parts to quote');
      const quotes = contexts.map(({ label, ctx }) => ({ label: label ?? null, ...plain(deps.cost.quote(ctx, base, material)) }));
      return { quotes, materialId: base.materialId || null };
    },

    'export.run': async p => {
      const known = deps.exporter.formats ?? ['obj', '3mf', 'stl', 'ply', 'wrl'];
      const bad = p.formats.find(f => !known.includes(f));
      if (bad) throw apiError('E_INVALID_PARAMS', `export.run: unknown format "${bad.slice(0, 32)}" (use ${known.join('|')})`, { field: 'formats' });
      const opt = p.options ?? {};
      for (const k of Object.keys(opt)) {
        if (!EXPORT_OPTION_KEYS.includes(k) || typeof opt[k] !== 'boolean') {
          throw apiError('E_INVALID_PARAMS', `export.run: options."${k}" is not a supported boolean option (${EXPORT_OPTION_KEYS.join('|')})`, { field: `options.${k}` });
        }
      }
      const res = await deps.exporter.collectExportFiles([...new Set(p.formats)], {
        ...opt, selectedOnly: p.selectedOnly === true,
      });
      if (res.blocked) {
        throw apiError('E_EXPORT_GATE', `export blocked (${res.code})`, { gate: res.code, issues: plain(res.readinessIssues ?? []) });
      }
      const files = res.files.map(f => ({ name: f.name, bytes: f.bytes }));   // bytes untouched
      emit('exportDone', { files: files.map(f => f.name), formats: [...new Set(p.formats)] });
      return files;
    },

    'render.png': async p => {
      const opts = {};
      if (p.width !== undefined) opts.width = p.width;
      if (p.height !== undefined) opts.height = p.height;
      if (p.preset !== undefined) {
        if (p.preset !== 'studio' && p.preset !== 'transparent') {
          throw apiError('E_INVALID_PARAMS', 'render.png: "preset" must be "studio" or "transparent"', { field: 'preset' });
        }
        opts.transparent = p.preset === 'transparent';
      }
      return { name: 'render.png', bytes: await toBytes(await deps.capture.capturePng(opts)) };
    },
    'render.thumbnail': async p => ({
      name: 'thumbnail.png',
      bytes: await toBytes(await deps.capture.captureListingShot(p.size !== undefined ? { size: p.size } : {})),
    }),

    'events.subscribe': async p => {
      const types = p.events && p.events.length ? [...new Set(p.events)] : [...EVENT_TYPES];
      setSubscriptions(types);
      return { subscribed: types };
    },
  };

  // Every v1 method must have a handler (guards drift between ApiSchema and here).
  for (const n of methodNames()) if (!H[n]) throw new Error(`ApiDispatcher: no handler for ${n}`);

  async function execute(method, params, signal) {
    const spec = getMethod(method);
    if (!spec) throw apiError('E_METHOD_NOT_FOUND', `unknown method "${String(method).slice(0, 64)}"`);
    if (spec.needsPath && !supportsRefs) {
      throw apiError('E_UNSUPPORTED', `${method} needs file access, which this runtime does not provide`);
    }
    const p = validateWithRefs(spec, params);
    if (IMMEDIATE.has(method)) return H[method](p);
    return enqueue(() => H[method](p, signal), signal);
  }

  // requestId -> { method, at, outcome }; Map order is arrival order, so the
  // oldest entries are pruned from the front.
  const outcomes = new Map();
  function once(requestId, method, run) {
    const t = now();
    for (const [id, r] of outcomes) {
      if (t - r.at <= REQUEST_ID_WINDOW_MS) break;
      outcomes.delete(id);
    }
    const prior = outcomes.get(requestId);
    if (prior) {
      if (prior.method !== method) {
        throw apiError('E_INVALID_PARAMS', `${method}: "requestId" was already used for ${prior.method}`, { field: 'requestId' });
      }
      return prior.outcome;
    }
    const outcome = run();
    outcomes.set(requestId, { method, at: t, outcome });
    if (outcomes.size > REQUEST_ID_MAX_REMEMBERED) outcomes.delete(outcomes.keys().next().value);
    outcome.catch(() => { if (outcomes.get(requestId)?.outcome === outcome) outcomes.delete(requestId); });
    return outcome;
  }

  /**
   * Run one method. Resolves to the result; rejects with an apiError object. An aborted
   * `signal` drops a request that has not started yet (E_CANCELLED).
   */
  async function dispatch(method, params, { signal } = {}) {
    try {
      const { requestId, params: rest } = takeRequestId(method, params);
      if (!requestId) return await execute(method, rest, signal);
      return await once(requestId, method, () => execute(method, rest, signal));
    } catch (e) {
      if (isApiError(e)) throw e;
      throw apiError('E_INTERNAL', scrubPaths(e?.message ?? e));
    }
  }

  function dispose() { setSubscriptions([]); }

  return { dispatch, dispose, methods: methodNames, validateParams };
}
