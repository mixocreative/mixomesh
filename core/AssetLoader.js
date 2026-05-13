import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { SceneManager } from './SceneManager.js';
import { ShaderLibrary } from './ShaderLibrary.js';
import { MeshValidator } from './MeshValidator.js';
import { Toast } from '../ui/Toast.js';
import { putHandle, getHandle } from './idb.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

const SUPPORTED_EXTENSIONS = ['.glb', '.gltf', '.obj', '.stl'];
const THUMB_SIZE  = 128;
const THUMB_LAYER = 0x40000000;     // unique camera mask bit for thumbnail isolation

// File-unit → metres. We assume Blender default export (metric / 0.001 / mm) so
// raw values in glTF / STL / OBJ are interpreted as millimetres unless the user
// overrides per-asset in Phase 3.
const SOURCE_UNIT_FACTORS = {
  millimeters: 0.001,
  centimeters: 0.01,
  meters:      1,
  inches:      0.0254,
  feet:        0.3048,
};
const DEFAULT_SOURCE_UNIT = 'millimeters';

// Module-local — never persisted in state.
const _containers   = new Map();    // assetId → BABYLON.AssetContainer
const _blobUrls     = new Map();    // assetId → object URL
const _meshRegistry = new Map();    // meshId  → BABYLON.AbstractMesh
const _dirHandles   = new Map();    // key     → FileSystemDirectoryHandle (session)

let _idCounter = 0;
const _newId = (prefix) => `${prefix}_${Date.now().toString(36)}_${++_idCounter}`;

// ── Public API ───────────────────────────────────────────

/**
 * Prompt the user to mount a directory via the File System Access API.
 * Persists the handle in IndexedDB for session restoration (Phase 6).
 * @returns {Promise<{handle: FileSystemDirectoryHandle, key: string}>}
 */
export async function mountDirectory() {
  const handle = await window.showDirectoryPicker();
  const key = `dir_${handle.name}_${Date.now()}`;
  _dirHandles.set(key, handle);
  await putHandle(key, handle);
  return { handle, key };
}

/**
 * Restore a previously-mounted directory handle (requires re-grant of permission).
 * @param {string} key
 * @returns {Promise<FileSystemDirectoryHandle|null>}
 */
export async function restoreDirectory(key) {
  const handle = await getHandle(key);
  if (!handle) return null;
  const granted = await handle.requestPermission({ mode: 'read' });
  if (granted !== 'granted') return null;
  _dirHandles.set(key, handle);
  return handle;
}

/**
 * Load an asset from a FileSystemFileHandle (Asset Panel drag).
 * @param {FileSystemFileHandle} fileHandle
 * @param {BABYLON.Vector3} [position]
 * @param {{ originalPath?: string, directoryHandleKey?: string }} [opts]
 * @returns {Promise<string[]>} created meshIds
 */
export async function loadFromHandle(fileHandle, position, opts = {}) {
  const file = await fileHandle.getFile();
  return loadFromBlob(file, file.name, position, opts);
}

/**
 * Load an asset from a Blob/File. Used by OS drag-drop and Asset Panel drops.
 * @param {Blob} blob
 * @param {string} filename
 * @param {BABYLON.Vector3} [position]
 * @param {{ originalPath?: string, directoryHandleKey?: string }} [opts]
 * @returns {Promise<string[]>} created meshIds
 */
export async function loadFromBlob(blob, filename, position, opts = {}) {
  const ext = _extOf(filename);
  if (!SUPPORTED_EXTENSIONS.includes(ext)) {
    throw new Error(`Unsupported file type: ${ext}`);
  }

  const scene = SceneManager.getScene();
  const assetId = _newId('asset');
  const blobUrl = URL.createObjectURL(blob);
  _blobUrls.set(assetId, blobUrl);

  const loadToastId = Toast.show(`Loading ${filename}…`, 'loading');

  try {
    const container = await BABYLON.SceneLoader.LoadAssetContainerAsync(
      blobUrl, '', scene, null, ext
    );
    _containers.set(assetId, container);

    const { byMaterial } = ShaderLibrary.registerFromContainer(container);

    container.addAllToScene();

    // Apply unit + working-ratio scaling. modelRatio comes from a glTF "ratio"
    // custom property if present (Blender custom prop), else 1:1. The result is
    // that 1 BU in the scene == 1 m at the scene's working ratio (its print size).
    // Export-time rescaling from working → target ratio happens in PrintManager.
    const sourceUnit    = DEFAULT_SOURCE_UNIT;
    const modelRatio    = _extractModelRatio(container) ?? 1;
    const workingRatio  = _currentWorkingRatio();
    const scaleFactor   = SOURCE_UNIT_FACTORS[sourceUnit] * (modelRatio / workingRatio);
    _applyImportScaling(container, scaleFactor, position);

    const entry = {
      id: assetId,
      name: filename.replace(/\.[^.]+$/, ''),
      filename,
      originalPath: opts.originalPath ?? filename,
      extension: ext,
      sourceUnit,
      unitConfirmed: true,
      modelRatio,
      directoryHandleKey: opts.directoryHandleKey ?? null,
      thumbnailDataUrl: null,
    };
    setState(s => ({
      ...s,
      scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [assetId]: entry } },
    }), { silent: true });
    dispatch(EVENTS.ASSET_REGISTERED, { assetId, entry });

    const meshIds = _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial);

    Toast.dismiss(loadToastId);

    _scheduleIdle(() => _generateThumbnailFor(assetId));
    for (const meshId of meshIds) _queueValidation(meshId);

    return meshIds;
  } catch (err) {
    Toast.dismiss(loadToastId);
    URL.revokeObjectURL(blobUrl);
    _blobUrls.delete(assetId);
    _containers.delete(assetId);
    throw err;
  }
}

/**
 * Dispose an asset's container if no SceneObjects still reference it.
 * @param {string} assetId
 */
export function releaseAsset(assetId) {
  const stillLinked = Object.values(getState().scene.objects).some(o => o.assetId === assetId && !o.isGhost);
  if (stillLinked) return;

  const container = _containers.get(assetId);
  if (container) {
    container.removeAllFromScene();
    container.dispose();
    _containers.delete(assetId);
  }
  const url = _blobUrls.get(assetId);
  if (url) { URL.revokeObjectURL(url); _blobUrls.delete(assetId); }

  setState(s => {
    const next = { ...s.scene.assetLibrary };
    delete next[assetId];
    return { ...s, scene: { ...s.scene, assetLibrary: next } };
  }, { silent: true });
}

/** @param {string} assetId */
export function getContainer(assetId) {
  return _containers.get(assetId) ?? null;
}

/** @param {string} meshId */
export function getBabylonMesh(meshId) {
  return _meshRegistry.get(meshId) ?? null;
}

/**
 * Clone an existing SceneObject — duplicates the Babylon mesh and registers
 * a new SceneObject entry referencing the same assetId / shader. The clone
 * appears offset from the source so it doesn't z-fight.
 *
 * @param {string} sourceMeshId
 * @param {{ x?:number, y?:number, z?:number }} [worldOffset]  In BU.
 * @returns {string|null} the new meshId, or null on failure
 */
export function cloneMeshAsNewObject(sourceMeshId, worldOffset) {
  const sourceMesh = _meshRegistry.get(sourceMeshId);
  const sourceObj  = getState().scene.objects[sourceMeshId];
  if (!sourceMesh || !sourceObj) return null;

  const newId = _newId('mesh');
  const clone = sourceMesh.clone(`${sourceMesh.name}.dup`, sourceMesh.parent ?? null, /*doNotCloneChildren*/ false);
  if (!clone) return null;

  if (worldOffset) {
    clone.position.x += worldOffset.x ?? 0;
    clone.position.y += worldOffset.y ?? 0;
    clone.position.z += worldOffset.z ?? 0;
  }
  clone.metadata   = { ...(sourceMesh.metadata ?? {}), meshId: newId };
  clone.isVisible  = sourceMesh.isVisible !== false;
  _meshRegistry.set(newId, clone);

  const newObj = {
    ...sourceObj,
    id: newId,
    name: _nextDupName(sourceObj.name),
    parentId: sourceObj.parentId ?? null,
  };
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { ...s.scene.objects, [newId]: newObj } },
  }), { silent: true });

  if (sourceObj.shaderId) ShaderLibrary.linkMesh(sourceObj.shaderId, newId);

  dispatch(EVENTS.ASSET_INSTANTIATED, { assetId: sourceObj.assetId, meshId: newId, meshName: clone.name });
  return newId;
}

/** Internal — used by DuplicateCommand's undo/redo to restore a saved clone. */
export function restoreCloneToScene(meshId, savedObj, mesh) {
  if (!_meshRegistry.has(meshId)) _meshRegistry.set(meshId, mesh);
  setState(s => ({
    ...s,
    scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: savedObj } },
  }), { silent: true });
}

function _nextDupName(baseName) {
  const objects = getState().scene.objects;
  const taken = new Set(Object.values(objects).map(o => o.name));
  // If name ends with .NNN, increment; else add .001
  const m = baseName.match(/^(.*)\.(\d{3,})$/);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 999; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${baseName}.dup`;
}

/** @param {string} key */
export function getDirectoryHandle(key) {
  return _dirHandles.get(key) ?? null;
}

// ── Helpers ──────────────────────────────────────────────

function _extOf(filename) {
  const i = filename.lastIndexOf('.');
  return i === -1 ? '' : filename.slice(i).toLowerCase();
}

function _scheduleIdle(fn) {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(fn, { timeout: 2000 });
  else setTimeout(fn, 50);
}

function _currentWorkingRatio() {
  const r = getState().print?.workingRatio;
  return typeof r === 'number' && r > 0 ? r : 1;
}

/**
 * Look for a Blender custom property called "ratio" inside the glTF "extras"
 * bag on any node in the container. Accepts '1/72', '1:72', or '72'. Returns
 * the denominator as a positive integer, or null when absent / malformed.
 */
function _extractModelRatio(container) {
  const nodes = [...container.meshes, ...container.transformNodes];
  for (const node of nodes) {
    const extras = node.metadata?.gltf?.extras;
    if (!extras) continue;
    const raw = extras.ratio ?? extras.Ratio;
    if (raw == null) continue;
    const parsed = _parseRatio(raw);
    if (parsed) return parsed;
  }
  return null;
}

function _parseRatio(raw) {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) return Math.round(raw);
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  // '1/72' or '1:72'  →  denominator
  let m = s.match(/^\s*1\s*[/:]\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const n = parseFloat(m[1]);
    return n > 0 ? Math.round(n) : null;
  }
  // bare number '72'  →  denominator
  m = s.match(/^\s*(\d+(?:\.\d+)?)\s*$/);
  if (m) {
    const n = parseFloat(m[1]);
    return n > 0 ? Math.round(n) : null;
  }
  return null;
}

/**
 * Apply the unit+ratio scale to the asset by BAKING it into vertex data
 * (rather than setting mesh.scaling). Every node ends with scaling=(1,1,1),
 * which matches user intuition ("1 mm in Blender should read as scale 1")
 * AND avoids the depth/stencil precision issues that HighlightLayer + gizmos
 * exhibit when world transforms operate at 0.001-scale.
 *
 * Local positions are scaled by the same factor so hierarchy offsets convert
 * to BU too. The drop offset is added to root nodes' positions on top.
 */
function _applyImportScaling(container, factor, position) {
  const scaleMat = BABYLON.Matrix.Scaling(factor, factor, factor);
  for (const m of container.meshes) {
    if (m.geometry && typeof m.bakeTransformIntoVertices === 'function') {
      m.bakeTransformIntoVertices(scaleMat);
    }
  }

  // Convert every local position into BU — child offsets within an asset
  // hierarchy were authored in the source unit too, not just the root.
  for (const n of [...container.meshes, ...container.transformNodes]) {
    n.position.scaleInPlace(factor);
  }

  // Drop anchor applies only to roots (typically Babylon's glTF __root__).
  const roots = [...container.meshes, ...container.transformNodes].filter(n => !n.parent);
  if (position) for (const r of roots) r.position.addInPlace(position);

  for (const m of container.meshes) m.refreshBoundingInfo?.();
}

function _registerInstantiatedMeshes(container, assetId, sourceUnit, byMaterial) {
  const meshIds = [];
  for (const mesh of container.meshes) {
    if (!mesh.geometry || (mesh.getTotalVertices?.() ?? 0) === 0) continue;
    const meshId = _newId('mesh');
    mesh.metadata = { ...(mesh.metadata ?? {}), meshId, assetId, sourceUnit };
    _meshRegistry.set(meshId, mesh);

    const shaderId = mesh.material ? byMaterial.get(mesh.material) : null;

    const sceneObject = {
      id: meshId,
      name: mesh.name || 'mesh',
      assetId,
      parentId: null,
      shaderId: shaderId ?? null,
      visible: mesh.isVisible !== false,
      locked: false,
      isGhost: false,
      isPrintPart: false,
      partLabel: '',
      partTolerance: 0,
    };
    setState(s => ({
      ...s,
      scene: { ...s.scene, objects: { ...s.scene.objects, [meshId]: sceneObject } },
    }), { silent: true });

    if (shaderId) ShaderLibrary.linkMesh(shaderId, meshId);

    meshIds.push(meshId);
    dispatch(EVENTS.ASSET_INSTANTIATED, { assetId, meshId, meshName: mesh.name });
  }
  return meshIds;
}

async function _generateThumbnailFor(assetId) {
  const container = _containers.get(assetId);
  if (!container) return;
  const meshes = container.meshes.filter(m => m.geometry && (m.getTotalVertices?.() ?? 0) > 0);
  if (!meshes.length) return;

  const totalVerts = meshes.reduce((s, m) => s + (m.getTotalVertices?.() ?? 0), 0);
  if (totalVerts > 500_000) return;   // BLUEPRINT §14.3 — skip thumbnail on very large meshes

  let dataUrl;
  try {
    dataUrl = await _renderThumbnail(meshes);
  } catch (err) {
    console.error('Thumbnail failed:', err);
    return;
  }

  setState(s => {
    const a = s.scene.assetLibrary[assetId];
    if (!a) return s;
    return {
      ...s,
      scene: {
        ...s.scene,
        assetLibrary: { ...s.scene.assetLibrary, [assetId]: { ...a, thumbnailDataUrl: dataUrl } },
      },
    };
  }, { silent: true });
  dispatch(EVENTS.ASSET_REGISTERED, { assetId, entry: { ...getState().scene.assetLibrary[assetId] } });
}

async function _renderThumbnail(meshes) {
  const scene  = SceneManager.getScene();
  const engine = SceneManager.getEngine();

  let min = new BABYLON.Vector3( Infinity,  Infinity,  Infinity);
  let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    const bi = m.getBoundingInfo();
    min = BABYLON.Vector3.Minimize(min, bi.boundingBox.minimumWorld);
    max = BABYLON.Vector3.Maximize(max, bi.boundingBox.maximumWorld);
  }
  const center = BABYLON.Vector3.Center(min, max);
  const diag   = max.subtract(min).length();
  const radius = Math.max(diag * 1.2, 0.4);

  const cam = new BABYLON.ArcRotateCamera('thumbCam', -Math.PI / 4, Math.PI / 3, radius, center, scene);
  cam.minZ = Math.max(diag * 0.001, 0.001);
  cam.maxZ = radius * 100;
  cam.layerMask = THUMB_LAYER;

  // Collect every node we want visible in the thumbnail (meshes + children).
  const visibleSet = new Set();
  for (const m of meshes) {
    visibleSet.add(m);
    m.getChildMeshes?.(false).forEach(c => visibleSet.add(c));
  }
  // OR the bit on so the meshes also stay visible to the main camera during the
  // screenshot. The thumb camera's layerMask is THUMB_LAYER alone, so it sees
  // only these meshes; the default main-camera mask still matches their other bits.
  const prevMasks = new Map();
  for (const m of visibleSet) { prevMasks.set(m, m.layerMask); m.layerMask = m.layerMask | THUMB_LAYER; }

  let dataUrl;
  try {
    dataUrl = await BABYLON.Tools.CreateScreenshotUsingRenderTargetAsync(
      engine, cam, { width: THUMB_SIZE, height: THUMB_SIZE }, 'image/png'
    );
  } finally {
    for (const [m, mask] of prevMasks) m.layerMask = mask;
    cam.dispose();
  }
  return dataUrl;
}

function _queueValidation(meshId) {
  const mesh = _meshRegistry.get(meshId);
  if (!mesh) return;
  const name = mesh.name || 'mesh';
  if (!MeshValidator.shouldAutoValidate(mesh)) {
    Toast.show(`${name}: skipped auto-validate (>100k verts)`, 'info', 4000);
    return;
  }
  const toastId = Toast.show(`Validating ${name}…`, 'loading');
  Promise.resolve().then(async () => {
    try {
      const results = await MeshValidator.validateMesh(mesh);
      Toast.dismiss(toastId);
      if (!results.length) {
        Toast.show(`✓ ${name}`, 'success', 3000);
        return;
      }
      const errs  = results.filter(r => r.severity === 'error').length;
      const warns = results.filter(r => r.severity === 'warning').length;
      if (errs > 0) {
        const w = warns ? `, ${warns} warning${warns === 1 ? '' : 's'}` : '';
        Toast.show(`✗ ${name}: ${errs} error${errs === 1 ? '' : 's'}${w}`, 'error', 0);
      } else {
        Toast.show(`⚠ ${name}: ${warns} warning${warns === 1 ? '' : 's'}`, 'warning', 0);
      }
    } catch (err) {
      Toast.dismiss(toastId);
      console.error('Validation failed:', err);
    }
  });
}

export const AssetLoader = {
  mountDirectory, restoreDirectory,
  loadFromHandle, loadFromBlob,
  releaseAsset, getContainer, getBabylonMesh, getDirectoryHandle,
  cloneMeshAsNewObject, restoreCloneToScene,
};
