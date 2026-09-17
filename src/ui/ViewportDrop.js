import { AssetLoader } from '../core/AssetLoader.js';
import { AssetPanel } from './AssetPanel.js';
import { Toast } from './Toast.js';
import { safeImport } from './ImportError.js';
import { reportError, safeAsync } from './Status.js';
import { t } from '../i18n/index.js';

const BABYLON = window.BABYLON;
const DRAG_MIME      = 'application/x-mixomesh-asset';
const SESSION_KEY    = '__session__';
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
  let handles;
  try {
    handles = await window.showOpenFilePicker({ multiple: true });
  } catch (err) {
    if (err?.name === 'AbortError') return;
    throw err;
  }
  const files = await Promise.all(handles.map(handle => handle.getFile()));
  const siblingFiles = files.filter(file => {
    const ext = _extOf(file.name);
    return ext === '.mtl' || AssetLoader.isTextureExt(ext);
  });
  const meshes = files.map((file, index) => ({ file, handle: handles[index] }))
    .filter(({ file }) => AssetLoader.isMeshExt(_extOf(file.name)));
  if (!meshes.length) {
    Toast.show(t('toast.dropNeedsMesh'), 'info', 5000);
    return;
  }
  for (const { file, handle } of meshes) {
    await safeImport(() => AssetLoader.loadFromBlob(file, file.name, position, {
      fileHandle: handle,
      ...(siblingFiles.length ? { siblingFiles } : {}),
    }), file.name);
  }
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

  // DataTransferItem and getAsFileSystemHandle() are only valid synchronously
  // inside the drop event — snapshot the File + handle-promise NOW, before any
  // await. The handle (Chrome-only) lets a loose OS drop relink later instead
  // of being a frozen snapshot. Fall back to dt.files when items is absent.
  const entries = [];
  const items = dt.items ? Array.from(dt.items) : [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const file = it.getAsFile();
    if (!file) continue;
    const handleP = it.getAsFileSystemHandle
      ? it.getAsFileSystemHandle().catch(() => null)
      : Promise.resolve(null);
    entries.push({ file, handleP });
  }
  if (!entries.length) {
    for (const f of (dt.files ? Array.from(dt.files) : [])) {
      entries.push({ file: f, handleP: Promise.resolve(null) });
    }
  }
  if (!entries.length) return;

  // Split the drop set: meshes load; .mtl + images ride along as SIBLINGS so
  // OBJ material/texture references resolve (they can't fetch relative to a
  // blob URL — field report: "obj fails to read mtl"). Drop obj+mtl+textures
  // together and they bind.
  const meshEntries = [];
  const siblingFiles = [];
  for (const { file, handleP } of entries) {
    const ext = _extOf(file.name);
    if (AssetLoader.isMeshExt(ext)) {
      meshEntries.push({ file, handleP });
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

  const importOne = async ({ file, handleP }) => {
    const h = await handleP;
    const fileHandle = h && h.kind === 'file' ? h : null;   // dir handles ignored for now
    await AssetLoader.loadFromBlob(file, file.name, position, {
      ...(fileHandle ? { fileHandle } : {}),
      ...(siblingFiles.length ? { siblingFiles } : {}),
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
    for (const entry of meshEntries) {
      try { await importOne(entry); ok++; }
      catch (err) { failures.push({ name: entry.file.name, err }); }
    }
    if (!failures.length) {
      Toast.show(t('toast.importedAll', { n: ok }), 'success', 3000);
      return;
    }
    const detail = failures.map(f => `${f.name}: ${f.err?.message ?? f.err}`).join('\n');
    reportError(new Error(detail), {
      modal: true,
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

export const ViewportDrop = { attach, promptImport };
