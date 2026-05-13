import { EVENTS } from '../core/events.js';
import { subscribe, setState, getState } from '../core/StateManager.js';
import { Selection } from '../core/Selection.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SceneManager } from '../core/SceneManager.js';
import { push, TransformCommand, VisibilityCommand, LockCommand, RenameCommand } from '../core/HistoryManager.js';
import { icon } from '../core/Icons.js';

const BABYLON = window.BABYLON;

// Must mirror AssetLoader.SOURCE_UNIT_FACTORS — duplicated to avoid a public
// export from AssetLoader. Keep them in sync if either changes.
const SOURCE_UNIT_FACTORS = {
  meters:      1,
  centimeters: 0.01,
  millimeters: 0.001,
  inches:      0.0254,
  feet:        0.3048,
};
const SOURCE_UNIT_LABELS = {
  meters:      'Metres (m)',
  centimeters: 'Centimetres (cm)',
  millimeters: 'Millimetres (mm)',
  inches:      'Inches (in)',
  feet:        'Feet (ft)',
};

let _root = null;
let _bodyEl = null;

// ── Init ─────────────────────────────────────────────────

/** Initialise the Properties panel. Must be called once after DOM is ready. */
export function init() {
  _root = document.getElementById('right-panel');
  _root.innerHTML = `
    <div class="pp-header"><span class="pp-title">Properties</span></div>
    <div class="pp-body" id="pp-body"></div>
  `;
  _bodyEl = _root.querySelector('#pp-body');

  const events = [
    EVENTS.SELECTION_CHANGED,
    EVENTS.ACTIVE_OBJECT_CHANGED,
    EVENTS.TRANSFORM_COMMITTED,
    EVENTS.VISIBILITY_CHANGED,
    EVENTS.LOCK_CHANGED,
    EVENTS.OBJECT_RENAMED,
    EVENTS.ASSET_REGISTERED,
    EVENTS.ASSET_INSTANTIATED,
  ];
  for (const ev of events) subscribe(ev, _render);
  _render();
}

// ── Render ───────────────────────────────────────────────

function _render() {
  if (!_bodyEl) return;
  const activeId = Selection.getActiveId();
  const objects  = getState().scene.objects;
  const obj      = activeId ? objects[activeId] : null;

  if (!obj) {
    _bodyEl.innerHTML = _renderSceneSection();
    _wireSceneSection();
    return;
  }

  const mesh   = AssetLoader.getBabylonMesh(activeId);
  const asset  = obj.assetId ? getState().scene.assetLibrary[obj.assetId] : null;
  const sel    = Selection.getSelectedIds();
  const multi  = sel.length > 1;

  _bodyEl.innerHTML = `
    ${_renderObjectSection(obj, multi, sel.length)}
    ${_renderTransformSection(mesh, multi)}
    ${asset ? _renderSourceUnitSection(asset) : ''}
  `;

  _wireObjectSection(obj);
  _wireTransformSection(activeId);
  if (asset) _wireSourceUnitSection(asset);
}

// ── Scene section (shown when no object is active) ───────

function _renderSceneSection() {
  const gridBU = getState().scene.gridSize ?? 0.3;
  const gridMM = gridBU * 1000;
  return `
    <section class="pp-section">
      <header class="pp-section-header">Scene</header>
      <div class="pp-row">
        <label>Grid size (mm)</label>
        <input type="number" step="10" min="10" id="pp-grid-size" value="${_fmt(gridMM, 0)}">
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Click a mesh to edit its properties.</span>
      </div>
    </section>
  `;
}

function _wireSceneSection() {
  const input = _bodyEl.querySelector('#pp-grid-size');
  if (!input) return;
  const commit = () => {
    const mm = parseFloat(input.value);
    if (!Number.isFinite(mm) || mm <= 0) { _render(); return; }
    SceneManager.setGridSize(mm / 1000);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { _render(); }
  });
}

// ── Object section ───────────────────────────────────────

function _renderObjectSection(obj, multi, total) {
  const visible = obj.visible !== false;
  const locked  = !!obj.locked;
  const nameVal = multi ? '—' : obj.name;
  const nameDisabled = multi ? 'disabled' : '';
  return `
    <section class="pp-section">
      <header class="pp-section-header">Object${multi ? ` <span class="pp-multi">(${total} selected)</span>` : ''}</header>
      <div class="pp-row">
        <label>Name</label>
        <input type="text" id="pp-name" value="${_escape(nameVal)}" ${nameDisabled}>
      </div>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" id="pp-visible" ${visible ? 'checked' : ''}> Visible</label>
        <label><input type="checkbox" id="pp-locked"  ${locked  ? 'checked' : ''}> Locked</label>
      </div>
    </section>
  `;
}

function _wireObjectSection(obj) {
  const nameEl = _bodyEl.querySelector('#pp-name');
  const visEl  = _bodyEl.querySelector('#pp-visible');
  const lockEl = _bodyEl.querySelector('#pp-locked');

  if (nameEl && !nameEl.disabled) {
    const commit = () => {
      const next = nameEl.value.trim();
      if (next && next !== obj.name) push(new RenameCommand(obj.id, obj.name, next));
    };
    nameEl.addEventListener('change', commit);
    nameEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      if (e.key === 'Escape') { nameEl.value = obj.name; nameEl.blur(); }
    });
  }

  visEl?.addEventListener('change', () => {
    push(new VisibilityCommand([obj.id], { [obj.id]: !!obj.visible }, visEl.checked));
  });
  lockEl?.addEventListener('change', () => {
    push(new LockCommand([obj.id], { [obj.id]: !!obj.locked }, lockEl.checked));
  });
}

// ── Transform section ────────────────────────────────────

function _renderTransformSection(mesh, multi) {
  if (!mesh) return '';
  const t = _readTransform(mesh);
  // mm and deg view for the user.
  const posMM = { x: t.position.x * 1000, y: t.position.y * 1000, z: t.position.z * 1000 };
  const rotDeg = _quatToEulerDeg(t.rotation);
  const sc = t.scaling;
  const dis = multi ? 'disabled' : '';

  // Print-space size from world AABB. The number to compare against the real
  // model spec on the box — "1:35 hull should be ~245 mm long".
  const sizeBU = multi ? _aggregateWorldSize(Selection.getSelectedResolved().map(r => r.mesh))
                       : _hierarchyWorldSize(mesh);
  const sizeMM = sizeBU ? { x: sizeBU.x * 1000, y: sizeBU.y * 1000, z: sizeBU.z * 1000 } : null;

  return `
    <section class="pp-section">
      <header class="pp-section-header">Transform</header>
      <div class="pp-grid3 pp-readonly">
        <label>Size (mm)</label>
        <span class="pp-readout">${sizeMM ? _fmt(sizeMM.x) : '—'}</span>
        <span class="pp-readout">${sizeMM ? _fmt(sizeMM.y) : '—'}</span>
        <span class="pp-readout">${sizeMM ? _fmt(sizeMM.z) : '—'}</span>
      </div>
      <div class="pp-grid3">
        <label>Pos (mm)</label>
        <input type="number" step="0.1" data-xform="position" data-axis="x" value="${_fmt(posMM.x)}" ${dis}>
        <input type="number" step="0.1" data-xform="position" data-axis="y" value="${_fmt(posMM.y)}" ${dis}>
        <input type="number" step="0.1" data-xform="position" data-axis="z" value="${_fmt(posMM.z)}" ${dis}>
      </div>
      <div class="pp-grid3">
        <label>Rot (°)</label>
        <input type="number" step="0.1" data-xform="rotation" data-axis="x" value="${_fmt(rotDeg.x)}" ${dis}>
        <input type="number" step="0.1" data-xform="rotation" data-axis="y" value="${_fmt(rotDeg.y)}" ${dis}>
        <input type="number" step="0.1" data-xform="rotation" data-axis="z" value="${_fmt(rotDeg.z)}" ${dis}>
      </div>
      <div class="pp-grid3">
        <label>Scale</label>
        <input type="number" step="0.001" data-xform="scaling" data-axis="x" value="${_fmt(sc.x, 4)}" ${dis}>
        <input type="number" step="0.001" data-xform="scaling" data-axis="y" value="${_fmt(sc.y, 4)}" ${dis}>
        <input type="number" step="0.001" data-xform="scaling" data-axis="z" value="${_fmt(sc.z, 4)}" ${dis}>
      </div>
    </section>
  `;
}

function _hierarchyWorldSize(mesh) {
  if (!mesh) return null;
  // getHierarchyBoundingVectors includes child meshes — correct for multi-mesh
  // glTF imports where the picked node is a parent transform.
  try {
    const r = mesh.getHierarchyBoundingVectors(true);
    return { x: r.max.x - r.min.x, y: r.max.y - r.min.y, z: r.max.z - r.min.z };
  } catch {
    const bi = mesh.getBoundingInfo?.();
    if (!bi) return null;
    const d = bi.boundingBox.maximumWorld.subtract(bi.boundingBox.minimumWorld);
    return { x: d.x, y: d.y, z: d.z };
  }
}

function _aggregateWorldSize(meshes) {
  if (!meshes.length) return null;
  let min = new BABYLON.Vector3( Infinity,  Infinity,  Infinity);
  let max = new BABYLON.Vector3(-Infinity, -Infinity, -Infinity);
  for (const m of meshes) {
    if (!m) continue;
    try {
      const r = m.getHierarchyBoundingVectors(true);
      min = BABYLON.Vector3.Minimize(min, r.min);
      max = BABYLON.Vector3.Maximize(max, r.max);
    } catch {
      const bi = m.getBoundingInfo?.();
      if (!bi) continue;
      min = BABYLON.Vector3.Minimize(min, bi.boundingBox.minimumWorld);
      max = BABYLON.Vector3.Maximize(max, bi.boundingBox.maximumWorld);
    }
  }
  if (!Number.isFinite(min.x)) return null;
  return { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z };
}

function _wireTransformSection(meshId) {
  if (!meshId) return;
  _bodyEl.querySelectorAll('[data-xform]').forEach(input => {
    if (input.disabled) return;
    input.addEventListener('change', () => _commitTransformInput(meshId, input));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { _render(); }
    });
  });
}

function _commitTransformInput(meshId, input) {
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (!mesh) return;

  const prev = _captureAbsolute(mesh);
  const next = _captureAbsolute(mesh);  // start from current; we'll override one component

  const which = input.dataset.xform;
  const axis  = input.dataset.axis;
  const value = parseFloat(input.value);
  if (!Number.isFinite(value)) { _render(); return; }

  if (which === 'position') {
    next.position[axis] = value / 1000;   // mm → BU
  } else if (which === 'rotation') {
    const e = _quatToEulerDeg(next.rotation);
    e[axis] = value;
    const q = BABYLON.Quaternion.FromEulerAngles(
      e.x * Math.PI / 180, e.y * Math.PI / 180, e.z * Math.PI / 180,
    );
    next.rotation = { x: q.x, y: q.y, z: q.z, w: q.w };
  } else if (which === 'scaling') {
    next.scaling[axis] = value;
  }
  if (_eq(prev, next)) return;

  push(new TransformCommand({ [meshId]: prev }, { [meshId]: next }));
}

// ── Source Unit section ──────────────────────────────────

function _renderSourceUnitSection(asset) {
  const opts = Object.entries(SOURCE_UNIT_LABELS).map(([k, label]) =>
    `<option value="${k}" ${k === asset.sourceUnit ? 'selected' : ''}>${label}</option>`
  ).join('');
  const warn = asset.unitConfirmed === false
    ? `<span class="pp-warn" title="Source unit unconfirmed — review the imported size">${icon('AlertTriangle', { width: 12, height: 12 })}</span>`
    : '';
  return `
    <section class="pp-section">
      <header class="pp-section-header">Source Unit ${warn}</header>
      <div class="pp-row">
        <label>Unit</label>
        <select id="pp-source-unit">${opts}</select>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Ratio 1:${asset.modelRatio ?? 1}</span>
        <button class="pp-btn" id="pp-confirm-unit" ${asset.unitConfirmed ? 'disabled' : ''}>Confirm</button>
      </div>
    </section>
  `;
}

function _wireSourceUnitSection(asset) {
  const sel = _bodyEl.querySelector('#pp-source-unit');
  const btn = _bodyEl.querySelector('#pp-confirm-unit');

  sel?.addEventListener('change', () => {
    const newUnit = sel.value;
    if (newUnit === asset.sourceUnit) return;
    _changeSourceUnit(asset, newUnit);
  });
  btn?.addEventListener('click', () => {
    setState(s => {
      const a = s.scene.assetLibrary[asset.id];
      if (!a) return s;
      return { ...s, scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [asset.id]: { ...a, unitConfirmed: true } } } };
    });
    _render();
  });
}

function _changeSourceUnit(asset, newUnit) {
  const oldUnit = asset.sourceUnit;
  const oldF = SOURCE_UNIT_FACTORS[oldUnit] ?? 0.001;
  const newF = SOURCE_UNIT_FACTORS[newUnit] ?? 0.001;
  if (oldF <= 0 || newF <= 0) return;
  const delta = newF / oldF;
  if (Math.abs(delta - 1) < 1e-12) return;

  // Detach the selection pivot so meshes are back in their canonical parents
  // while we rebake — matches the pattern used by hierarchy commands.
  SceneManager.attachToSelection([], 'median', null);

  // Re-bake the scale DELTA into vertex data, keeping mesh.scaling at the
  // user's current value (typically 1). Non-root local positions scale too,
  // so within-asset spacing follows. The world drop anchor (root position)
  // is left alone so the asset stays where the user placed it.
  const objects = getState().scene.objects;
  const meshIds = Object.keys(objects).filter(id => objects[id].assetId === asset.id);
  const scaleMat = BABYLON.Matrix.Scaling(delta, delta, delta);
  for (const id of meshIds) {
    const m = AssetLoader.getBabylonMesh(id);
    if (!m) continue;
    if (m.geometry && typeof m.bakeTransformIntoVertices === 'function') {
      m.bakeTransformIntoVertices(scaleMat);
    }
    if (m.parent) m.position.scaleInPlace(delta);
    m.refreshBoundingInfo?.();
  }

  setState(s => {
    const a = s.scene.assetLibrary[asset.id];
    if (!a) return s;
    return {
      ...s,
      scene: { ...s.scene, assetLibrary: { ...s.scene.assetLibrary, [asset.id]: { ...a, sourceUnit: newUnit, unitConfirmed: false } } },
    };
  });
  Selection.refresh();
  _render();
}

// ── Helpers ──────────────────────────────────────────────

function _readTransform(mesh) {
  mesh.computeWorldMatrix(true);
  const ap = mesh.getAbsolutePosition();
  const aq = mesh.absoluteRotationQuaternion ?? BABYLON.Quaternion.Identity();
  const as = mesh.absoluteScaling ?? mesh.scaling;
  return {
    position: { x: ap.x, y: ap.y, z: ap.z },
    rotation: { x: aq.x, y: aq.y, z: aq.z, w: aq.w },
    scaling:  { x: as.x, y: as.y, z: as.z },
  };
}

function _captureAbsolute(mesh) {
  return _readTransform(mesh);
}

function _quatToEulerDeg(q) {
  const quat = new BABYLON.Quaternion(q.x, q.y, q.z, q.w);
  const e = quat.toEulerAngles();
  return { x: e.x * 180 / Math.PI, y: e.y * 180 / Math.PI, z: e.z * 180 / Math.PI };
}

function _eq(a, b) {
  for (const k of ['x', 'y', 'z']) {
    if (Math.abs(a.position[k] - b.position[k]) > 1e-9) return false;
    if (Math.abs(a.scaling[k]  - b.scaling[k])  > 1e-9) return false;
  }
  for (const k of ['x', 'y', 'z', 'w']) {
    if (Math.abs(a.rotation[k] - b.rotation[k]) > 1e-9) return false;
  }
  return true;
}

function _fmt(n, dp = 2) {
  return Number.isFinite(n) ? n.toFixed(dp) : '0';
}

function _escape(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

export const PropertiesPanel = { init };
