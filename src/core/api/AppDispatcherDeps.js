// AppDispatcherDeps — wires the REAL app modules into the pure dispatcher
// (ADR 0005, API.2). The only file in core/api that imports app singletons.
// Lazy dynamic imports (like LaunchRequests.init) keep this headless-safe to
// import; `createAppDispatcher()` resolves them once.
//
// Seams: StateManager (state), Selection, HistoryManager (+ Transform/Delete/
// ApplyPrinterProfile commands -> every mutation is undoable), PersistenceManager,
// ViewportDrop.importPicked, AssetPanel.mountFromRef + storage.listDirectory,
// MeshValidator, RepairSession.repairObjects (via MeshValidator), PrintPipeline
// (readiness + collectExportFiles), PrintCost + previewExportContext, FrameCapture,
// PrinterProfiles. Nothing here writes a second exporter.

import { createDispatcher } from './ApiDispatcher.js';
import { externalLane } from './ExternalLane.js';

const MM = 1000;   // BU -> mm (ExportContext.BU_TO_MM)

/** @returns {Promise<ReturnType<typeof createDispatcher>>} */
/** @param {object} [extra] extra deps merged last (the bridge supplies `notify(evt)`). */
export async function createAppDispatcher(extra = {}) {
  const [
    SM, { EVENTS }, SelectionMod, History, Persistence, Dirty, Drop, Panel, Validator,
    Pipeline, Cost, ExportCtx, Capture, Profiles, Materials, Scale, Loader, { storage }, Gate, TriCount, Logical,
    { withRestTransform },
  ] = await Promise.all([
    import('../StateManager.js'),
    import('../events.js'),
    import('../Selection.js'),
    import('../HistoryManager.js'),
    import('../PersistenceManager.js'),
    import('../persist/DirtyTracker.js'),
    import('../../ui/ViewportDrop.js'),
    import('../../ui/AssetPanel.js'),
    import('../MeshValidator.js'),
    import('../print/PrintPipeline.js'),
    import('../print/PrintCost.js'),
    import('../print/ExportContext.js'),
    import('../RenderOutput.js'),
    import('../print/PrinterProfiles.js'),
    import('../print/MaterialPresets.js'),
    import('../scale/ScaleMath.js'),
    import('../AssetLoader.js'),
    import('../storage/StorageAdapter.js'),
    import('../persist/LoadGate.js'),
    import('../scene/TriangleCount.js'),
    import('../LogicalObjects.js'),
    import('../scene/ImportBounce.js'),
  ]);
  const { Selection } = SelectionMod;
  const { PersistenceManager } = Persistence;
  const { AssetLoader } = Loader;
  const BAB = () => globalThis.BABYLON;

  let lastMount = null;   // { ref } of the folder library.list reads

  const readTransform = mesh => {
    mesh.computeWorldMatrix(true);
    const p = mesh.getAbsolutePosition();
    const q = mesh.absoluteRotationQuaternion ?? BAB().Quaternion.Identity();
    const s = mesh.absoluteScaling ?? mesh.scaling;
    return {
      position: { x: p.x, y: p.y, z: p.z },
      rotation: { x: q.x, y: q.y, z: q.z, w: q.w },
      scaling: { x: s.x, y: s.y, z: s.z },
    };
  };

  /** Build the TransformCommand the Properties panel would (mm / deg / multiplier). */
  function buildTransform(id, patch) {
    const state = SM.getState();
    const targetIds = state.scene.objects[id]
      ? (Logical.logicalObjectPartIds(id, state.scene.objects).length
        ? Logical.logicalObjectPartIds(id, state.scene.objects) : [id])
      : [id];
    const prev = {}; const next = {};
    for (const nid of targetIds) {
      const node = AssetLoader.getBabylonMesh(nid);
      if (!node) continue;
      prev[nid] = readTransform(node);
      const n = readTransform(node);
      if (patch.position_mm) {
        n.position = { x: patch.position_mm[0] / MM, y: patch.position_mm[1] / MM, z: patch.position_mm[2] / MM };
      }
      if (patch.rotation_deg) {
        const r = patch.rotation_deg.map(d => d * Math.PI / 180);
        const q = BAB().Quaternion.FromEulerAngles(r[0], r[1], r[2]);
        n.rotation = { x: q.x, y: q.y, z: q.z, w: q.w };
      }
      if (patch.scale !== undefined) {
        const f = Array.isArray(patch.scale) ? patch.scale : [patch.scale, patch.scale, patch.scale];
        n.scaling = { x: n.scaling.x * f[0], y: n.scaling.y * f[1], z: n.scaling.z * f[2] };
      }
      next[nid] = n;
    }
    if (!Object.keys(next).length) return null;
    return new History.TransformCommand(prev, next);
  }

  // Measured at RESTING scale: a just-imported object may be mid import-bounce.
  function metrics(partIds) { return withRestTransform(() => metricsNow(partIds)); }

  function metricsNow(partIds) {
    let min = null; let max = null; let triangles = 0;
    for (const pid of partIds) {
      const mesh = AssetLoader.getBabylonMesh(pid);
      if (!mesh) continue;
      triangles += TriCount.meshTriangles(mesh);
      mesh.computeWorldMatrix?.(true);
      const bb = mesh.getBoundingInfo?.().boundingBox;
      if (!bb) continue;
      // Print space, same mapping as the status-bar HUD / phone viewer: print X = scene X,
      // print Y (depth) = scene Z, print Z (height) = scene Y.
      const lo = [bb.minimumWorld.x, bb.minimumWorld.z, bb.minimumWorld.y];
      const hi = [bb.maximumWorld.x, bb.maximumWorld.z, bb.maximumWorld.y];
      min = min ? min.map((v, i) => Math.min(v, lo[i])) : lo;
      max = max ? max.map((v, i) => Math.max(v, hi[i])) : hi;
    }
    if (!min) return { bounds_mm: null, triangles };
    const mm = a => a.map(v => v * MM);
    return {
      bounds_mm: { min: mm(min), max: mm(max), size: max.map((v, i) => (v - min[i]) * MM) },   // print space [W, D, H], Z up
      triangles,
    };
  }

  /** Run fn with the selection temporarily set to ids (cost/export "selected only"). */
  async function withSelection(ids, fn) {
    if (!ids || !ids.length) return fn(false);
    const prevIds = Selection.getSelectedIds();
    const prevActive = Selection.getActiveId();
    Selection.set(ids, ids[ids.length - 1]);
    try { return await fn(true); } finally { Selection.set(prevIds, prevActive); }
  }

  const targetLabel = t => (t == null ? 'as shown' : t.kind === 'factor' ? `x${t.value}` : t.kind === 'height' ? `${t.mm} mm` : `1:${t.value ?? t.ratio ?? '?'}`);

  const deps = {
    appVersion: import.meta.env?.VITE_APP_VERSION ?? null,
    runtime: storage.kind,
    supportsRefs: storage.kind === 'desktop',
    isBusy: () => AssetLoader.isImporting() || Gate.isLoading(),
    lane: externalLane,
    state: { getState: SM.getState, subscribe: SM.subscribe },
    EVENTS,
    selection: { set: (ids, active) => Selection.set(ids, active), getSelectedIds: () => Selection.getSelectedIds() },
    history: { push: History.push },
    commands: {
      transform: buildTransform,
      remove: ids => new History.DeleteCommand(ids),
      applyPrinter: id => new History.ApplyPrinterProfileCommand(id),
    },
    persistence: {
      isDirty: () => PersistenceManager.isDirty(),
      // Returns the undo: PROJECT_DIRTY marks the work unsaved again (sticky) if the replacement fails.
      discardChanges: () => {
        Dirty.clearDirty();
        return () => SM.dispatch(EVENTS.PROJECT_DIRTY, {});
      },
      hasSaveTarget: () => Persistence.hasSaveTarget(),
      newProject: () => PersistenceManager.newProject(),
      openPicked: picked => PersistenceManager.openPicked(picked),
      save: () => PersistenceManager.save(),
      saveAs: picked => PersistenceManager.saveAs(picked),
    },
    readFile: ref => storage.readFile(ref),
    importPicked: picked => Drop.ViewportDrop.importPicked(picked),
    mountLibrary: async picked => {
      const m = await AssetLoader.registerMount(picked);
      await Panel.AssetPanel.mountFromRef(picked);
      lastMount = { ref: m.ref };
    },
    listLibrary: async subdir => {
      if (!lastMount) return null;
      let ref = lastMount.ref; let path = '';
      for (const seg of String(subdir).split(/[\\/]+/).filter(Boolean)) {
        const entry = (await storage.listDirectory(ref, path)).find(e => e.kind === 'directory' && e.name === seg);
        if (!entry) return null;
        ref = entry.ref; path = entry.path;
      }
      return storage.listDirectory(ref, path);
    },
    metrics,
    printers: {
      list: () => Profiles.listPrinterProfiles(),
      get: () => Profiles.getPrinterProfile(),
      exists: id => Profiles.printerProfileExists(id),
      currentId: () => Profiles.getPrinterProfile().id,
    },
    validator: {
      validateAll: () => Validator.validateAllPrintParts(),
      validateOne: async id => {
        const mesh = AssetLoader.getBabylonMesh(id);
        return mesh ? Validator.validateMesh(mesh) : [];
      },
    },
    repair: { run: ids => Validator.MeshValidator.repairObjects(ids) },
    readiness: { get: opts => Pipeline.getPrintReadiness(opts) },
    cost: {
      material: id => Materials.getMaterialPresets().find(m => m.id === id) ?? null,
      quote: (ctx, settings, material) => Cost.quote(ctx, settings, material),
      contexts: ({ ids, selectedOnly }) => withSelection(ids, used => {
        const targets = Scale.exportTargetsFromState(SM.getState());
        const list = targets.length ? targets : [null];
        const out = [];
        for (let i = 0; i < list.length; i++) {
          const ctx = ExportCtx.previewExportContext({ targetIndex: i, selectedOnly: used || selectedOnly });
          if (ctx) out.push({ label: targetLabel(list[i]), ctx });
        }
        return out;
      }),
    },
    exporter: {
      formats: ['obj', '3mf', 'stl', 'ply', 'wrl'],
      collectExportFiles: (formats, options) => Pipeline.collectExportFiles(formats, options),
    },
    capture: {
      capturePng: opts => Capture.capturePng(opts),
      captureListingShot: opts => Capture.captureListingShot(opts),
    },
  };
  return createDispatcher({ ...deps, ...extra });
}
