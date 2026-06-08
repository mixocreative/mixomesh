import { AssetLoader } from '../core/AssetLoader.js';
import { AssetPanel } from './AssetPanel.js';
import { Toast, safeAsync } from './Toast.js';

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
    safeAsync(async () => {
      const { mountKey, path, filename } = JSON.parse(panelPayload);
      if (mountKey === SESSION_KEY) {
        // path IS the assetId; re-instantiate from existing container
        await AssetLoader.instantiateAsset(path, position);
        return;
      }
      const handle = AssetPanel.getFileHandle(mountKey, path);
      if (!handle) throw new Error(`No file handle for ${filename}`);
      await AssetLoader.loadFromHandle(handle, position, {
        directoryHandleKey: mountKey, originalPath: path,
      });
    });
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

  for (const { file, handleP } of entries) {
    const ext = _extOf(file.name);
    if (!AssetLoader.isMeshExt(ext)) {
      Toast.show(`Skipped ${file.name}: unsupported (${ext || 'no ext'})`, 'warning', 4000);
      continue;
    }
    safeAsync(async () => {
      const h = await handleP;
      const fileHandle = h && h.kind === 'file' ? h : null;   // dir handles ignored for now
      await AssetLoader.loadFromBlob(file, file.name, position, fileHandle ? { fileHandle } : {});
    });
  }
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

export const ViewportDrop = { attach };
