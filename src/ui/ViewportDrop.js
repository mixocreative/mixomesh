import { AssetLoader } from '../core/AssetLoader.js';
import { AssetPanel } from './AssetPanel.js';
import { Toast } from './Toast.js';
import { safeImport } from './ImportError.js';
import { reportError, safeAsync } from './Status.js';
import { t } from '../i18n/index.js';
import { storage } from '../core/storage/StorageAdapter.js';
// Decision 16: new-file imports go through the "already in this project" check.
import { importWithDedupe, beginImportBatch } from '../core/assets/AssetImport.js';
import { SESSION_KEY } from '../core/assets/DirMounts.js';   // one shared constant (4.9)
import { MM_PER_BU } from '../core/scene/SceneConstants.js';

const BABYLON = window.BABYLON;
const DRAG_MIME      = 'application/x-mixomesh-asset';
// Multi-file drops/picks are staggered along +X so N files don't land stacked
// on one point (overhaul 5.6, plan §4.7 "Drops"). Gap between neighbours, mm.
const STAGGER_GAP_MM = 10;
// Mesh-extension support is owned by AssetLoader (single source of truth —
// `.3mf` etc. extend there, not here).

/**
 * Wire drag-and-drop on the viewport. Drops can come from:
 *  - the AssetPanel (custom MIME with mountKey + path)
 *  - the OS file explorer (DataTransfer.files)
 * Drop position is ray-picked onto the ground plane.
 *
 * @param {HTMLElement} viewportEl
 * @param {BABYLON.Scene} scene
 */
export function attach(viewportEl, scene) {
  const overlay = viewportEl.querySelector('#viewport-drop-overlay') ?? viewportEl;

  let dragDepth = 0;
  const onEnter = (e) => {
    if (!_isAcceptable(e)) return;
    dragDepth++;
    viewportEl.classList.add('drag-over');
    e.preventDefault();
  };
  const onOver  = (e) => {
    if (!_isAcceptable(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onLeave = () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) viewportEl.classList.remove('drag-over');
  };
  const onDrop  = (e) => {
    dragDepth = 0;
    viewportEl.classList.remove('drag-over');
    if (!_isAcceptable(e)) return;
    e.preventDefault();
    const position = _pickGroundPosition(scene, e);
    _handleDrop(e, position);
  };

  viewportEl.addEventListener('dragenter', onEnter);
  viewportEl.addEventListener('dragover',  onOver);
  viewportEl.addEventListener('dragleave', onLeave);
  viewportEl.addEventListener('drop',      onDrop);
  overlay.addEventListener('dragover', (e) => e.preventDefault());
}

/** Picker entry point shared by the viewport empty state and future menus. */
export async function promptImport(position = BABYLON.Vector3.Zero()) {
  const picked = await storage.pickImportAssets({ multiple: true });
  await importPicked(picked, position);
}

/**
 * Import already-picked assets ([{ref,name}], mesh + sibling MTL/textures).
 * Shared by the picker and launch-time file arguments.
 * @param {Array<{ref:any, name?:string}>} picked
 * @param {BABYLON.Vector3} [position]
 * @param {{ signal?: AbortSignal }} [opts]  the caller's cancel stops the
 *   running file and the rest of the pick (API request, cia F-08)
 */
export async function importPicked(picked, position = BABYLON.Vector3.Zero(), { signal } = {}) {
  if (!picked?.length) return;
  const files = await Promise.all(picked.map(p => storage.readFile(p.ref)));
  const siblingFiles = files.filter(file => {
    const ext = _extOf(file.name);
    return ext === '.mtl' || AssetLoader.isTextureExt(ext);
  });
  const meshes = files.map((file, index) => ({ file, ref: picked[index].ref }))
    .filter(({ file }) => AssetLoader.isMeshExt(_extOf(file.name)));
  if (!meshes.length) {
    Toast.show(t('toast.dropNeedsMesh'), 'info', 5000);
    return;
  }
  let at = position;
  // Cancel ends the whole pick, not just the file that was running (review I5).
  const batch = beginImportBatch({ signal });
  try {
    for (const { file, ref } of meshes) {
      if (batch.signal.aborted) break;
      const ids = await safeImport(() => batch.run(async (batchSignal) => {
        const fileHandleKey = await _persistedKey(ref);
        return importWithDedupe(file, file.name, at, {
          ...(fileHandleKey ? { fileHandleKey } : {}),
          ...(siblingFiles.length ? { siblingFiles } : {}),
          signal: batchSignal,
        });
      }), file.name);
      at = _nextStaggerPosition(at, ids);
    }
  } finally {
    batch.end();
  }
}

/**
 * Next drop position after an import placed `meshIds`: to the +X side of the
 * just-placed object, one gap plus half its width further (the next object is
 * assumed to be centred on its drop point — exact for most models, a heuristic
 * for off-centre origins). Unchanged when nothing was placed (cancelled
 * dedupe prompt / failed import).
 * @param {any} at   BABYLON.Vector3 drop point just used
 * @param {string[]|undefined} meshIds
 * @returns {any} BABYLON.Vector3
 */
function _nextStaggerPosition(at, meshIds) {
  const b = _boundsX(meshIds);
  if (!b) return at;
  const next = at.clone();
  next.x = staggerNextX(b.minX, b.maxX, STAGGER_GAP_MM / MM_PER_BU);
  return next;
}

/**
 * Pure stagger rule (unit-tested): next centre X = placed max X + gap + half
 * the placed width.
 * @param {number} minX @param {number} maxX @param {number} gap  all BU
 */
export function staggerNextX(minX, maxX, gap) {
  return maxX + gap + Math.max(0, maxX - minX) / 2;
}

// World X extent of the live meshes for `meshIds`, or null when none resolve.
function _boundsX(meshIds) {
  if (!Array.isArray(meshIds) || !meshIds.length) return null;
  let minX = Infinity, maxX = -Infinity;
  for (const id of meshIds) {
    const m = AssetLoader.getBabylonMesh?.(id);
    if (!m?.getBoundingInfo) continue;
    m.computeWorldMatrix?.(true);
    const bb = m.getBoundingInfo().boundingBox;
    minX = Math.min(minX, bb.minimumWorld.x);
    maxX = Math.max(maxX, bb.maximumWorld.x);
  }
  return Number.isFinite(minX) ? { minX, maxX } : null;
}

/** Opaque ref → stable adapter key so a loose file stays linked; null = embedded-only. */
async function _persistedKey(ref) {
  if (!ref) return null;
  try { return await storage.persistRef(ref); } catch { return null; }
}

// ── Predicates ───────────────────────────────────────────

function _isAcceptable(e) {
  const dt = e.dataTransfer;
  if (!dt) return false;
  if (dt.types?.includes(DRAG_MIME)) return true;
  if (dt.types?.includes('Files'))   return true;
  return false;
}

// ── Drop handling ────────────────────────────────────────

function _handleDrop(e, position) {
  const dt = e.dataTransfer;

  const panelPayload = dt.getData(DRAG_MIME);
  if (panelPayload) {
    const { mountKey, path, sourcePath, filename } = JSON.parse(panelPayload);
    safeImport(async () => {
      if (mountKey === SESSION_KEY) {
        // path IS the assetId; re-instantiate from existing container
        await AssetLoader.instantiateAsset(path, position);
        return;
      }
      const handle = AssetPanel.getFileHandle(mountKey, path);
      if (!handle) throw new Error(`No file handle for ${filename}`);
      await AssetLoader.loadFromHandle(handle, position, {
        directoryHandleKey: mountKey, originalPath: sourcePath ?? path,
      });
    }, filename ?? 'asset');
    return;
  }

  // DataTransferItems are only valid synchronously inside the drop event —
  // snapshot the File + the adapter's ref-promise NOW, before any await
  // (`storage.refForDrop` is synchronous for exactly this reason). The ref lets
  // a loose OS drop relink later instead of being a frozen snapshot. Fall back
  // to dt.files when items is absent.
  const entries = [];
  const items = dt.items ? Array.from(dt.items) : [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const file = it.getAsFile();
    if (!file) continue;
    entries.push({ file, refP: storage.refForDrop(it) });
  }
  if (!entries.length) {
    for (const f of (dt.files ? Array.from(dt.files) : [])) {
      entries.push({ file: f, refP: Promise.resolve(null) });
    }
  }
  if (!entries.length) return;

  // Split the drop set: meshes load; .mtl + images ride along as SIBLINGS so
  // OBJ material/texture references resolve (they can't fetch relative to a
  // blob URL — field report: "obj fails to read mtl"). Drop obj+mtl+textures
  // together and they bind.
  const meshEntries = [];
  const siblingFiles = [];
  for (const { file, refP } of entries) {
    const ext = _extOf(file.name);
    if (AssetLoader.isMeshExt(ext)) {
      meshEntries.push({ file, refP });
    } else if (ext === '.mtl' || AssetLoader.isTextureExt(ext)) {
      siblingFiles.push(file);
    } else {
      Toast.show(t('toast.dropSkipped', { name: file.name, ext: ext || 'no ext' }), 'warning', 4000);
    }
  }
  if (!meshEntries.length) {
    if (siblingFiles.length) {
      Toast.show(t('toast.dropNeedsMesh'), 'info', 5000);
    }
    return;
  }

  const importOne = async ({ file, refP }, at = position, signal = undefined) => {
    const fileHandleKey = await _persistedKey(await refP);
    return importWithDedupe(file, file.name, at, {
      ...(fileHandleKey ? { fileHandleKey } : {}),
      ...(siblingFiles.length ? { siblingFiles } : {}),
      ...(signal ? { signal } : {}),
    });
  };

  if (meshEntries.length === 1) {
    safeImport(() => importOne(meshEntries[0]), meshEntries[0].file.name);
    return;
  }

  // Multi-file drop: SEQUENTIAL, in drop order (audit F1/F2/F16). Parallel
  // imports let a second failure's modal replace the first (Modal.open swaps
  // the live modal) and let two shader-merge prompts cancel each other; and
  // nobody got a "3 of 5 imported" answer. One summary at the end instead.
  safeAsync(async () => {
    const failures = [];
    let ok = 0;
    let done = 0;        // files that reached an outcome (imported, declined or failed)
    let at = position;   // staggered along +X per placed file (overhaul 5.6)
    // Cancel ends the whole drop: no further files (review I5), but what
    // already happened is still reported (cia B-09).
    const batch = beginImportBatch();
    try {
      for (const entry of meshEntries) {
        if (batch.signal.aborted) break;
        try {
          const ids = await batch.run((signal) => importOne(entry, at, signal));
          at = _nextStaggerPosition(at, ids);
          if (ids?.length) ok++;   // a declined duplicate prompt imports nothing
          done++;
        } catch (err) {
          if (err?.name === 'AbortError') break;
          failures.push({ name: entry.file.name, err });
          done++;
        }
      }
    } finally {
      batch.end();
    }
    const cancelled = meshEntries.length - done;
    if (!failures.length) {
      if (cancelled) Toast.show(t('toast.importCancelledRest', { ok, n: meshEntries.length }), 'info', 5000);
      else Toast.show(t('toast.importedAll', { n: ok }), 'success', 3000);
      return;
    }
    const lines = failures.map(f => `${f.name}: ${f.err?.message ?? f.err}`);
    if (cancelled) lines.push(t('import.restCancelled', { n: cancelled }));
    const detail = lines.join('\n');
    // One shared cause keeps its code, so the modal explains it (e.g. over budget).
    const codes = new Set(failures.map(f => f.err?.code ?? null));
    const code = codes.size === 1 ? [...codes][0] : null;
    reportError(Object.assign(new Error(detail), code ? { code } : {}), {
      modal: true,
      importing: true,
      title: t('toast.importedPartial', { ok, n: meshEntries.length }),
    });
  });
}

// ── Ray-pick onto ground plane ───────────────────────────

function _pickGroundPosition(scene, e) {
  const canvas = scene.getEngine().getRenderingCanvas();
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const ray = scene.createPickingRay(x, y, BABYLON.Matrix.Identity(), scene.activeCamera);

  const ground = scene.getMeshByName('grid');
  if (ground) {
    const hit = ray.intersectsMesh(ground, false);
    if (hit?.hit && hit.pickedPoint) return hit.pickedPoint;
  }
  // Fallback — analytic intersection with y = 0 plane.
  if (Math.abs(ray.direction.y) < 1e-6) return BABYLON.Vector3.Zero();
  const t = -ray.origin.y / ray.direction.y;
  if (t < 0) return BABYLON.Vector3.Zero();
  return ray.origin.add(ray.direction.scale(t));
}

function _extOf(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

export const ViewportDrop = { attach, promptImport, importPicked, staggerNextX };
