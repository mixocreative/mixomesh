import { EVENTS } from '../core/events.js';
import { subscribe, setState, getState } from '../core/StateManager.js';
import { Selection } from '../core/Selection.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { SOURCE_UNIT_FACTORS } from '../core/ImportNormalizer.js';
import { SceneManager } from '../core/SceneManager.js';
import {
  push, beginBatch, endBatch,
  TransformCommand, VisibilityCommand, LockCommand, RenameCommand,
  ShaderAssignCommand, ShaderDuplicateCommand, UVOverrideCommand,
  PrintPartCommand, BakeTransformCommand,
} from '../core/HistoryManager.js';
import { ShaderPanel, renderShaderPreview } from './ShaderPanel.js';
import { icon } from '../core/Icons.js';

const BABYLON = window.BABYLON;

// SOURCE_UNIT_FACTORS imported from ImportNormalizer.js — single source of
// truth for the import-normalization seam (no more hand-synced duplicate).
const SOURCE_UNIT_LABELS = {
  meters:      'Metres (m)',
  centimeters: 'Centimetres (cm)',
  millimeters: 'Millimetres (mm)',
  inches:      'Inches (in)',
  feet:        'Feet (ft)',
};

let _root = null;
let _bodyEl = null;
// Section keys that the user has collapsed. Preserved across re-renders, lost
// on page reload (intentional for Phase 4 — persistence lands in Phase 6).
const _collapsedSections = new Set();

// ── Init ─────────────────────────────────────────────────

/** Initialise the Properties panel. Must be called once after DOM is ready. */
export function init() {
  // The right column is now a stack of collapsible sections; we render into
  // our pre-mounted body container (see index.html). No private header — the
  // section shell owns it.
  _root = document.getElementById('rp-properties');
  _bodyEl = document.getElementById('rp-properties-body');
  _bodyEl.classList.add('pp-body');

  const events = [
    EVENTS.SELECTION_CHANGED,
    EVENTS.ACTIVE_OBJECT_CHANGED,
    EVENTS.TRANSFORM_COMMITTED,
    EVENTS.VISIBILITY_CHANGED,
    EVENTS.LOCK_CHANGED,
    EVENTS.OBJECT_RENAMED,
    EVENTS.ASSET_REGISTERED,
    EVENTS.ASSET_INSTANTIATED,
    EVENTS.SHADER_CREATED,
    EVENTS.SHADER_UPDATED,
    EVENTS.SHADER_ASSIGNED,
    EVENTS.SHADER_DUPLICATED,
    EVENTS.COLOR_APPLIED,
    EVENTS.UV_OVERRIDE_CHANGED,
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
    ${_renderShaderSection(obj)}
    ${_renderUVOverrideSection(obj)}
    ${_renderPrintPartSection(obj)}
  `;

  _wireObjectSection(obj);
  _wireTransformSection(activeId);
  if (asset) _wireSourceUnitSection(asset);
  _wireShaderSection();
  _wireUVOverrideSection(obj);
  _wirePrintPartSection(obj);
  _applyAndWireSectionCollapse();
}

function _applyAndWireSectionCollapse() {
  _bodyEl.querySelectorAll('.pp-section[data-section]').forEach(sec => {
    const key = sec.dataset.section;
    if (_collapsedSections.has(key)) sec.classList.add('pp-collapsed');
    const header = sec.querySelector(':scope > .pp-section-header');
    if (!header) return;
    header.addEventListener('click', () => {
      sec.classList.toggle('pp-collapsed');
      if (sec.classList.contains('pp-collapsed')) _collapsedSections.add(key);
      else _collapsedSections.delete(key);
    });
  });
}

// ── Scene section (shown when no object is active) ───────

function _renderSceneSection() {
  const grid = getState().scene.grid ?? { cellMM: 10, subdivisions: 10 };
  const bed  = getState().print.bedDimensions;
  return `
    <section class="pp-section" data-section="scene">
      <header class="pp-section-header">Scene</header>
      <div class="pp-row">
        <label>Grid cell (mm)</label>
        <input type="number" step="1" min="0.1" id="pp-grid-cell" value="${_fmt(grid.cellMM, 2)}">
      </div>
      <div class="pp-row">
        <label>Subdivisions</label>
        <input type="number" step="1" min="1" id="pp-grid-subdiv" value="${_fmt(grid.subdivisions, 0)}">
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Bed ${_fmt(bed.x, 2)} × ${_fmt(bed.y, 2)} mm — set in Print ▸ Bed.</span>
      </div>
      <div class="pp-row pp-row-inline">
        <span class="pp-hint">Click a mesh to edit its properties.</span>
      </div>
    </section>
  `;
}

function _wireSceneSection() {
  const cellInput   = _bodyEl.querySelector('#pp-grid-cell');
  const subdivInput = _bodyEl.querySelector('#pp-grid-subdiv');
  if (!cellInput || !subdivInput) return;
  const commit = () => {
    const cellMM = parseFloat(cellInput.value);
    const subdivisions = parseInt(subdivInput.value, 10);
    if (!Number.isFinite(cellMM) || cellMM <= 0 ||
        !Number.isFinite(subdivisions) || subdivisions < 1) {
      _render();
      return;
    }
    SceneManager.setGrid({ cellMM, subdivisions });
  };
  for (const input of [cellInput, subdivInput]) {
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { _render(); }
    });
  }
}

// ── Object section ───────────────────────────────────────

function _renderObjectSection(obj, multi, total) {
  const visible = obj.visible !== false;
  const locked  = !!obj.locked;
  const nameVal = multi ? '—' : obj.name;
  const nameDisabled = multi ? 'disabled' : '';
  return `
    <section class="pp-section" data-section="object">
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

  const scaleLocked = getState().ui?.scaleLocked !== false;
  const lockedCls = scaleLocked ? 'pp-locked' : '';
  const lockIcon = scaleLocked ? 'Lock' : 'Unlock';
  const applyDis = multi ? 'disabled' : '';

  return `
    <section class="pp-section" data-section="transform">
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
        <label>
          Rot (°)
          <button class="pp-apply-btn" data-apply="rotation" ${applyDis} title="Bake current rotation into vertices; reset to 0,0,0">Apply</button>
        </label>
        <input type="number" step="0.1" data-xform="rotation" data-axis="x" value="${_fmt(rotDeg.x)}" ${dis}>
        <input type="number" step="0.1" data-xform="rotation" data-axis="y" value="${_fmt(rotDeg.y)}" ${dis}>
        <input type="number" step="0.1" data-xform="rotation" data-axis="z" value="${_fmt(rotDeg.z)}" ${dis}>
      </div>
      <div class="pp-grid3 pp-scale-row ${lockedCls}">
        <label>
          Scale
          <button class="pp-apply-btn" data-apply="scale" ${applyDis} title="Bake current scale into vertices; reset to 1,1,1">Apply</button>
        </label>
        <input type="number" step="0.001" data-xform="scaling" data-axis="x" value="${_fmt(sc.x, 4)}" ${dis}>
        <input type="number" step="0.001" data-xform="scaling" data-axis="y" value="${_fmt(sc.y, 4)}" ${dis}>
        <input type="number" step="0.001" data-xform="scaling" data-axis="z" value="${_fmt(sc.z, 4)}" ${dis}>
      </div>
      <div class="pp-row pp-row-inline">
        <button class="pp-icon-btn pp-scale-lock" data-action="scaleLock" title="${scaleLocked ? 'Unlock per-axis scale' : 'Lock proportional scale'}">${icon(lockIcon, { width: 13, height: 13 })}</button>
        <span class="pp-hint">${scaleLocked ? 'Scale locked — edits mirror across XYZ' : 'Scale unlocked — per-axis edits'}</span>
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

  _bodyEl.querySelectorAll('[data-apply]').forEach(btn => {
    if (btn.disabled) return;
    btn.addEventListener('click', () => {
      const kind = btn.dataset.apply;            // 'rotation' | 'scale'
      push(new BakeTransformCommand(meshId, kind));
      _render();
    });
  });

  const lockBtn = _bodyEl.querySelector('[data-action="scaleLock"]');
  lockBtn?.addEventListener('click', () => {
    const cur = getState().ui?.scaleLocked !== false;
    setState(s => ({ ...s, ui: { ...s.ui, scaleLocked: !cur } }), { silent: true });
    SceneManager.setScaleLock(!cur);
    _render();
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
    // Scale lock: edits on any axis mirror proportionally to the other two.
    // The mirror is RATIO-based (newAxis / oldAxis), so the part keeps its
    // current aspect ratio if the user has already biased it.
    const locked = getState().ui?.scaleLocked !== false;
    if (locked) {
      const prevVal = prev.scaling[axis];
      const ratio = (Number.isFinite(prevVal) && Math.abs(prevVal) > 1e-9) ? (value / prevVal) : 1;
      next.scaling.x = prev.scaling.x * ratio;
      next.scaling.y = prev.scaling.y * ratio;
      next.scaling.z = prev.scaling.z * ratio;
      next.scaling[axis] = value;             // exact match on edited axis
    } else {
      next.scaling[axis] = value;
    }
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
    <section class="pp-section" data-section="source-unit">
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

// ── Shader section (binding-only slot list) ──────────────

/**
 * Slot list. Each slot represents one distinct shader currently bound to the
 * selected meshes (active mesh's bucket first). The slot exposes:
 *   • a click target that focuses the shader in the Shader Library
 *   • a combined dropdown to either replace the binding with another shader
 *     or duplicate it in place (clone + reassign in one undo entry)
 *
 * Shader *appearance* (color / texture / sliders / UV base) is edited only in
 * the Library — auto-focus brings the active mesh's shader into the editor
 * when the active object changes.
 */
function _renderShaderSection(obj) {
  const libShaders = Object.values(getState().scene.shaders);
  if (!libShaders.length) {
    return `
      <section class="pp-section" data-section="shader">
        <header class="pp-section-header">Shader</header>
        <div class="pp-row pp-row-inline">
          <span class="pp-hint">No shaders in scene yet. Drop an asset, or create one in the Shader Library.</span>
        </div>
      </section>
    `;
  }

  const activeId = Selection.getActiveId();
  const selIds   = Selection.getSelectedIds();
  const meshIds  = selIds.length ? selIds : [obj.id];

  // Buckets by shader, then re-ordered so the active mesh's bucket is first.
  const buckets = _collectShaderBuckets(meshIds);
  const activeBucketIdx = buckets.findIndex(b => b.meshIds.includes(activeId));
  if (activeBucketIdx > 0) {
    const [active] = buckets.splice(activeBucketIdx, 1);
    buckets.unshift(active);
  }

  const slotsHtml = buckets.map(b => _renderShaderSlot(b, libShaders)).join('');

  return `
    <section class="pp-section">
      <header class="pp-section-header">
        Shader
        <span class="pp-multi">${meshIds.length === 1 ? '' : `(${meshIds.length} meshes)`}</span>
      </header>
      <div class="pp-shader-list">${slotsHtml}</div>
    </section>
  `;
}

function _collectShaderBuckets(meshIds) {
  const objects = getState().scene.objects;
  const byShader = new Map();   // shaderId (or '' for none) → meshIds[]
  for (const id of meshIds) {
    const o = objects[id];
    if (!o) continue;
    const key = o.shaderId ?? '';
    if (!byShader.has(key)) byShader.set(key, []);
    byShader.get(key).push(id);
  }
  return Array.from(byShader.entries()).map(([shaderId, ids]) => ({
    shaderId: shaderId || null,
    meshIds:  ids,
  }));
}

function _renderShaderSlot(bucket, libShaders) {
  // Empty bucket — meshes with no shader bound. Compact assign-only dropdown,
  // no duplicate option (nothing to clone from).
  if (!bucket.shaderId) {
    const opts = libShaders.map(s => `<option value="shader:${s.id}">${_escape(s.name)}</option>`).join('');
    return `
      <div class="pp-shader-slot pp-shader-slot-empty"
           data-bucket-shader=""
           data-bucket-meshes="${bucket.meshIds.join(',')}">
        <span class="pp-shader-chip pp-shader-chip-empty">${icon('AlertTriangle', { width: 12, height: 12 })}</span>
        <span class="pp-shader-name">No shader</span>
        <span class="pp-shader-meshcount">${bucket.meshIds.length}</span>
        <select class="pp-slot-dropdown" aria-label="Assign shader">
          <option value="" selected hidden>Assign…</option>
          <optgroup label="Assign with">${opts}</optgroup>
        </select>
      </div>
    `;
  }

  const sh = getState().scene.shaders[bucket.shaderId];
  if (!sh) return '';

  const replaceOpts = libShaders
    .filter(s => s.id !== sh.id)
    .map(s => `<option value="shader:${s.id}">${_escape(s.name)}</option>`)
    .join('');

  return `
    <div class="pp-shader-slot"
         data-bucket-shader="${sh.id}"
         data-bucket-meshes="${bucket.meshIds.join(',')}">
      <button class="pp-slot-info" type="button" data-slot-focus="${sh.id}"
              title="Open ${_escape(sh.name)} in the Shader Library">
        ${renderShaderPreview(sh, 18)}
        <span class="pp-shader-name">${_escape(sh.name)}</span>
        <span class="pp-shader-meshcount" title="${bucket.meshIds.length} mesh${bucket.meshIds.length === 1 ? '' : 'es'} in selection">${bucket.meshIds.length}</span>
      </button>
      <select class="pp-slot-dropdown" aria-label="Change shader on this slot">
        <option value="" selected hidden>${_escape(sh.name)}</option>
        ${replaceOpts ? `<optgroup label="Replace with">${replaceOpts}</optgroup>` : ''}
        <optgroup label="Actions">
          <option value="duplicate">Duplicate in place</option>
        </optgroup>
      </select>
    </div>
  `;
}

function _wireShaderSection() {
  // Slot click → focus the shader in the Library (replaces the old Edit button).
  _bodyEl.querySelectorAll('[data-slot-focus]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.slotFocus;
      if (id) ShaderPanel.focus(id);
    });
  });

  // Combined dropdown: shader id → replace; "duplicate" → duplicate in place.
  _bodyEl.querySelectorAll('.pp-slot-dropdown').forEach(sel => {
    sel.addEventListener('change', () => {
      const v = sel.value;
      // Always reset back to the placeholder so the dropdown reads as "current
      // shader" between actions, regardless of which option was just chosen.
      sel.value = '';

      const slot = sel.closest('.pp-shader-slot');
      const sourceId = slot?.dataset.bucketShader || null;
      const targets = (slot?.dataset.bucketMeshes ?? '').split(',').filter(Boolean);
      if (!targets.length) return;

      if (v.startsWith('shader:')) {
        const nextId = v.slice('shader:'.length);
        if (!nextId || nextId === sourceId) return;
        push(new ShaderAssignCommand(targets, nextId));
        return;
      }

      if (v === 'duplicate' && sourceId) {
        beginBatch('Duplicate Shader in Place');
        const dup = new ShaderDuplicateCommand(sourceId);
        push(dup);
        const newId = dup.getNewId();
        if (newId) push(new ShaderAssignCommand(targets, newId));
        endBatch();
        if (newId) ShaderPanel.focus(newId);
      }
    });
  });
}

// ── UV Override section ──────────────────────────────────

function _renderUVOverrideSection(obj) {
  if (!obj.shaderId) return '';
  const override = getState().scene.uvOverrides[obj.id] ?? null;
  const active = !!override;
  const uv = override ?? { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
  return `
    <section class="pp-section" data-section="uv-override">
      <header class="pp-section-header">
        UV Override
        ${active ? '<span class="pp-multi">(active)</span>' : ''}
      </header>
      <div class="pp-grid3">
        <label>Offset</label>
        <input type="number" step="0.01" id="pp-uv-ox" value="${_fmt(uv.offsetX, 3)}">
        <input type="number" step="0.01" id="pp-uv-oy" value="${_fmt(uv.offsetY, 3)}">
        <span class="pp-readout-thin">U / V</span>
      </div>
      <div class="pp-grid3">
        <label>Scale</label>
        <input type="number" step="0.05" id="pp-uv-sx" value="${_fmt(uv.scaleX, 3)}">
        <input type="number" step="0.05" id="pp-uv-sy" value="${_fmt(uv.scaleY, 3)}">
        <span class="pp-readout-thin">U / V</span>
      </div>
      <div class="pp-row">
        <label>Rotation</label>
        <input type="number" step="0.05" id="pp-uv-rot" value="${_fmt(uv.rotation, 3)}">
      </div>
      <div class="pp-row-inline">
        <span class="pp-hint">${active ? 'Per-mesh override of the shader\'s UV base.' : 'No override — using shader UV base.'}</span>
        <button class="pp-btn" id="pp-uv-reset" ${active ? '' : 'disabled'}>Reset to Default</button>
      </div>
    </section>
  `;
}

function _wireUVOverrideSection(obj) {
  if (!obj.shaderId) return;
  const fields = [
    ['pp-uv-ox',  'offsetX'],
    ['pp-uv-oy',  'offsetY'],
    ['pp-uv-sx',  'scaleX'],
    ['pp-uv-sy',  'scaleY'],
    ['pp-uv-rot', 'rotation'],
  ];

  for (const [elId, key] of fields) {
    const el = _bodyEl.querySelector(`#${elId}`);
    if (!el) continue;
    el.addEventListener('change', () => {
      const n = parseFloat(el.value);
      if (!Number.isFinite(n)) { _render(); return; }
      const prev = getState().scene.uvOverrides[obj.id] ?? null;
      const base = prev ?? { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 };
      if (Math.abs(base[key] - n) < 1e-9) return;
      const next = { ...base, [key]: n };
      push(new UVOverrideCommand(obj.id, prev, next));
    });
  }

  _bodyEl.querySelector('#pp-uv-reset')?.addEventListener('click', () => {
    const prev = getState().scene.uvOverrides[obj.id] ?? null;
    if (!prev) return;
    push(new UVOverrideCommand(obj.id, prev, null));
  });
}

// ── Print Part section ───────────────────────────────────

function _renderPrintPartSection(obj) {
  const isPrintPart = obj.isPrintPart ?? false;
  const partLabel = obj.partLabel ?? '';
  const partTolerance = obj.partTolerance ?? 0;

  return `
    <section class="pp-section" data-section="print-part">
      <header class="pp-section-header">Print Part</header>
      <div class="pp-row pp-row-inline">
        <label><input type="checkbox" id="pp-is-print-part" ${isPrintPart ? 'checked' : ''}> Export as print part</label>
      </div>
      ${isPrintPart ? `
      <div class="pp-row">
        <label>Part Label</label>
        <input type="text" id="pp-part-label" value="${_escape(partLabel)}">
      </div>
      <div class="pp-row">
        <label>Tolerance (mm)</label>
        <input type="number" step="0.1" id="pp-part-tolerance" value="${_fmt(partTolerance, 1)}">
      </div>
      ` : '<div class="pp-row-inline"><span class="pp-hint">Not marked for export.</span></div>'}
    </section>
  `;
}

function _wirePrintPartSection(obj) {
  const isPrintPartCb = _bodyEl.querySelector('#pp-is-print-part');
  if (!isPrintPartCb) return;

  isPrintPartCb.addEventListener('change', () => {
    const prev = {
      isPrintPart: !!obj.isPrintPart,
      partLabel: obj.partLabel ?? '',
      partTolerance: obj.partTolerance ?? 0,
    };
    const next = {
      isPrintPart: isPrintPartCb.checked,
      partLabel: isPrintPartCb.checked ? (obj.partLabel ?? '') : '',
      partTolerance: isPrintPartCb.checked ? (obj.partTolerance ?? 0) : 0,
    };
    push(new PrintPartCommand(obj.id, prev, next));
  });

  // Wire label and tolerance inputs if print part is checked
  const labelEl = _bodyEl.querySelector('#pp-part-label');
  const toleranceEl = _bodyEl.querySelector('#pp-part-tolerance');

  if (labelEl) {
    labelEl.addEventListener('change', () => {
      const prev = {
        isPrintPart: true,
        partLabel: obj.partLabel ?? '',
        partTolerance: obj.partTolerance ?? 0,
      };
      const next = {
        isPrintPart: true,
        partLabel: labelEl.value.trim(),
        partTolerance: obj.partTolerance ?? 0,
      };
      if (next.partLabel !== prev.partLabel) {
        push(new PrintPartCommand(obj.id, prev, next));
      }
    });
  }

  if (toleranceEl) {
    toleranceEl.addEventListener('change', () => {
      const n = parseFloat(toleranceEl.value);
      if (!Number.isFinite(n) || n < 0) { _render(); return; }
      const prev = {
        isPrintPart: true,
        partLabel: obj.partLabel ?? '',
        partTolerance: obj.partTolerance ?? 0,
      };
      const next = {
        isPrintPart: true,
        partLabel: obj.partLabel ?? '',
        partTolerance: n,
      };
      if (Math.abs(next.partTolerance - prev.partTolerance) > 1e-9) {
        push(new PrintPartCommand(obj.id, prev, next));
      }
    });
  }
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
