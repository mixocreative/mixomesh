import { EVENTS } from '../core/events.js';
import { subscribe, getState, setState, dispatch } from '../core/StateManager.js';
import { Selection } from '../core/Selection.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { ShaderLibrary, DEFAULT_SWATCHES } from '../core/ShaderLibrary.js';
import {
  push,
  ShaderCreateCommand, ShaderUpdateCommand, ShaderDuplicateCommand,
  ShaderDeleteCommand, ShaderAssignCommand, ColorApplyCommand,
} from '../core/HistoryManager.js';
import { Toast, safeAsync } from './Toast.js';
import { icon } from '../core/Icons.js';
import { AssetPanel } from './AssetPanel.js';
import { Modal } from './Modal.js';
import { escapeHtml as _escape, escapeAttr, safeImageSrc } from './renderSafe.js';

const DRAG_MIME       = 'application/x-mixomesh-asset';
const SHADER_DRAG_MIME = 'application/x-mixomesh-shader';
const SESSION_KEY     = '__session__';   // mirrors ui/AssetPanel.js

let _bodyEl       = null;
let _editingId    = null;     // shaderId currently in the inline editor
// Section keys the user has collapsed inside the panel. Preserved across
// renders this session; not persisted (Phase 6 work).
const _collapsedSections = new Set();

// ── Init ─────────────────────────────────────────────────

/** Initialise the Shader panel. Must be called once after DOM is ready. */
export function init() {
  _bodyEl = document.getElementById('rp-shaders-body');
  if (!_bodyEl) return;
  _bodyEl.classList.add('sp-body');

  // Re-render whenever anything shader-shaped changes.
  const events = [
    EVENTS.SHADER_CREATED,
    EVENTS.SHADER_UPDATED,
    EVENTS.SHADER_DUPLICATED,
    EVENTS.SHADER_ASSIGNED,
    EVENTS.COLOR_APPLIED,
    EVENTS.UV_OVERRIDE_CHANGED,
    EVENTS.SELECTION_CHANGED,
    EVENTS.ASSET_REGISTERED,
    EVENTS.ASSET_REMOVED,
    EVENTS.ASSET_INSTANTIATED,
    EVENTS.OBJECT_REMOVED,
    EVENTS.OBJECT_RESTORED,
  ];
  for (const ev of events) subscribe(ev, _render);

  // Auto-focus: when the active object changes, surface its shader in the
  // editor — unless the user is mid-edit inside the Library, in which case
  // we leave them be so they don't lose focus / pending text.
  subscribe(EVENTS.ACTIVE_OBJECT_CHANGED, _onActiveObjectChanged);

  Modal.register('shaderMerge', _renderMergeModal);
  Modal.register('texturePick', _renderTexturePickModal);

  _render();
}

function _onActiveObjectChanged({ activeId }) {
  if (!activeId) return;
  if (_libraryHasFocus()) return;
  const obj = getState().scene.objects[activeId];
  if (!obj?.shaderId) return;
  if (obj.shaderId === _editingId) return;
  focus(obj.shaderId);
}

/** True when an editable element inside the Library currently has focus. */
function _libraryHasFocus() {
  const active = document.activeElement;
  if (!active) return false;
  const lib = document.getElementById('rp-shaders');
  if (!lib?.contains(active)) return false;
  const tag = active.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// ── Texture picker ───────────────────────────────────────

function _openTexturePicker(shaderId) {
  const sh = getState().scene.shaders[shaderId];
  if (!sh) return;
  const lib = getState().scene.assetLibrary;
  const textures = Object.values(lib).filter(a => a.kind === 'texture');
  if (!textures.length) {
    Toast.show('No textures loaded yet — drag an image into the Asset Panel first', 'info', 3000);
    return;
  }
  dispatch(EVENTS.MODAL_OPEN, {
    id: 'texturePick',
    shaderId,
    currentAssetId: sh.diffuseTextureAssetId,
    textures,
    onClose: (result) => {
      if (!result || typeof result.assetId === 'undefined') return;
      _applyTexturePick(shaderId, result.assetId);
    },
  });
}

function _applyTexturePick(shaderId, nextAssetId) {
  const sh = getState().scene.shaders[shaderId];
  if (!sh) return;
  if (sh.diffuseTextureAssetId === nextAssetId) return;
  // updateShader (via the command) handles both state and Babylon material.
  push(new ShaderUpdateCommand(shaderId, 'diffuseTextureAssetId', sh.diffuseTextureAssetId, nextAssetId));
}

function _renderTexturePickModal({ data, close }) {
  const current = data.currentAssetId;
  const root = document.createElement('div');
  root.innerHTML = `
    <header class="modal-header">
      ${icon('Image', { width: 18, height: 18 })}
      <span>Pick texture</span>
    </header>
    <div class="modal-body">
      <p>Choose any texture already loaded in the scene library.</p>
      <div class="tp-grid">
        ${data.textures.map(t => _renderTexturePickCard(t, current === t.id)).join('')}
      </div>
    </div>
    <div class="modal-footer">
      <button class="modal-btn" data-tp-cancel>Cancel</button>
    </div>
  `;

  root.querySelectorAll('.tp-card').forEach(card => {
    card.addEventListener('click', () => {
      close({ assetId: card.dataset.assetId });
    });
  });
  root.querySelector('[data-tp-cancel]').addEventListener('click', () => close(null));

  return root;
}

function _renderTexturePickCard(tex, isCurrent) {
  const thumbSrc = safeImageSrc(tex.thumbnailDataUrl);
  const thumb = thumbSrc
    ? `<img src="${thumbSrc}" alt="">`
    : `<div class="tp-card-thumb-empty">${icon('Image', { width: 28, height: 28 })}</div>`;
  return `
    <button class="tp-card ${isCurrent ? 'tp-card-current' : ''}"
            data-asset-id="${escapeAttr(tex.id)}"
            title="${escapeAttr(tex.filename)}">
      ${thumb}
      <span class="tp-card-name">${_escape(tex.name)}</span>
    </button>
  `;
}

// ── Shader merge modal renderer ──────────────────────────

function _renderMergeModal({ data, close }) {
  const conflicts = data.conflicts ?? [];
  // Per-conflict choice. Default Rename per BLUEPRINT.
  const choices = {};
  for (const c of conflicts) choices[c.name] = 'rename';

  const root = document.createElement('div');
  root.innerHTML = `
    <header class="modal-header">
      ${icon('AlertTriangle', { width: 18, height: 18 })}
      <span>Shader name conflicts</span>
    </header>
    <div class="modal-body">
      <p>
        ${conflicts.length} material${conflicts.length === 1 ? '' : 's'} in this asset
        share names with shaders already in the scene. Choose how to resolve each:
      </p>
      <div class="mm-apply-all">
        <label>Apply to all:
          <select id="mm-apply-all">
            <option value="">— choose —</option>
            <option value="useExisting">Use existing</option>
            <option value="rename" selected>Rename</option>
            <option value="replace">Replace</option>
          </select>
        </label>
      </div>
      <ul class="mm-list">
        ${conflicts.map(_renderConflictRow).join('')}
      </ul>
    </div>
    <div class="modal-footer">
      <button class="modal-btn" data-mm-cancel>Cancel</button>
      <button class="modal-btn modal-btn-primary" data-mm-confirm>Apply</button>
    </div>
  `;

  // Apply-to-all dropdown sweeps every row's radios.
  root.querySelector('#mm-apply-all').addEventListener('change', (e) => {
    const v = e.target.value;
    if (!v) return;
    for (const c of conflicts) {
      choices[c.name] = v;
      const radio = root.querySelector(`input[name="mm-${_cssId(c.name)}"][value="${v}"]`);
      if (radio) radio.checked = true;
    }
  });

  // Per-row radios.
  root.querySelectorAll('.mm-row').forEach(rowEl => {
    const name = rowEl.dataset.name;
    rowEl.querySelectorAll('input[type="radio"]').forEach(r => {
      r.addEventListener('change', () => {
        if (r.checked) choices[name] = r.value;
      });
    });
  });

  root.querySelector('[data-mm-cancel]').addEventListener('click', () => close(null));
  root.querySelector('[data-mm-confirm]').addEventListener('click', () => close({ choices }));

  return root;
}

function _renderConflictRow(c) {
  const id = _cssId(c.name);
  return `
    <li class="mm-row" data-name="${escapeAttr(c.name)}">
      <div class="mm-row-name">${_escape(c.name)}</div>
      <div class="mm-row-opts">
        <label><input type="radio" name="mm-${id}" value="useExisting"> Use existing</label>
        <label><input type="radio" name="mm-${id}" value="rename" checked> Rename</label>
        <label><input type="radio" name="mm-${id}" value="replace"> Replace</label>
      </div>
    </li>
  `;
}

function _cssId(name) {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── Render ───────────────────────────────────────────────

function _render() {
  if (!_bodyEl) return;
  const shaders = Object.values(getState().scene.shaders);
  // Heal stale editingId after delete / undo.
  if (_editingId && !shaders.some(s => s.id === _editingId)) {
    _editingId = null;
  }

  _bodyEl.innerHTML = `
    ${_renderList(shaders)}
    ${_editingId ? _renderEditor(getState().scene.shaders[_editingId]) : _renderEditorEmpty()}
    ${_renderSwatches()}
  `;

  _wireList();
  if (_editingId) _wireEditor(_editingId);
  _wireSwatches();
  _applyAndWireSectionCollapse();
}

function _applyAndWireSectionCollapse() {
  _bodyEl.querySelectorAll('.sp-section[data-section]').forEach(sec => {
    const key = sec.dataset.section;
    if (_collapsedSections.has(key)) sec.classList.add('sp-collapsed');
    const header = sec.querySelector(':scope > .sp-section-header');
    if (!header) return;
    header.addEventListener('click', (e) => {
      // Clicks on header-internal buttons (e.g. + new shader) shouldn't toggle.
      if (e.target.closest('button')) return;
      sec.classList.toggle('sp-collapsed');
      if (sec.classList.contains('sp-collapsed')) _collapsedSections.add(key);
      else _collapsedSections.delete(key);
    });
  });
}

// ── Shader list ──────────────────────────────────────────

function _renderList(shaders) {
  const rows = shaders.length
    ? shaders.map(s => _renderListRow(s)).join('')
    : '<div class="sp-empty">No shaders. Click + to create one.</div>';

  return `
    <section class="sp-section" data-section="list">
      <header class="sp-section-header">
        <span>Scene Shaders</span>
        <button class="sp-icon-btn" id="sp-new" title="New shader">${icon('Plus', { width: 14, height: 14 })}</button>
      </header>
      <ul class="sp-list">${rows}</ul>
    </section>
  `;
}

function _renderListRow(sh) {
  const selected = sh.id === _editingId ? 'sp-row-selected' : '';
  return `
    <li class="sp-row ${selected}" data-shader-id="${escapeAttr(sh.id)}" tabindex="0" role="option" aria-selected="${sh.id === _editingId ? 'true' : 'false'}" draggable="true">
      ${renderShaderPreview(sh, 18)}
      <span class="sp-row-name" title="${escapeAttr(sh.name)}">${_escape(sh.name)}</span>
      <span class="sp-row-count" title="Meshes using this shader">${sh.linkedMeshIds.length}</span>
      <button class="sp-row-act" data-sp-dup="${escapeAttr(sh.id)}" title="Duplicate this shader">${icon('Copy', { width: 12, height: 12 })}</button>
    </li>
  `;
}

/**
 * Small chip that previews a shader's appearance. Renders the texture
 * thumbnail when one is assigned, otherwise the diffuse colour. Exported so
 * PropertiesPanel can reuse the same visual in its multi-shader list.
 * @param {object} sh   ShaderEntry
 * @param {number} size pixel size of the chip (square)
 */
export function renderShaderPreview(sh, size = 18) {
  const tex = sh.diffuseTextureAssetId
    ? getState().scene.assetLibrary[sh.diffuseTextureAssetId]
    : null;
  const thumbSrc = safeImageSrc(tex?.thumbnailDataUrl);
  if (thumbSrc) {
    return `<span class="sp-swatch-chip sp-swatch-tex" style="width:${size}px;height:${size}px;background-image:url('${thumbSrc}')"></span>`;
  }
  return `<span class="sp-swatch-chip" style="width:${size}px;height:${size}px;background:${_safeHex(sh.diffuseColor)}"></span>`;
}

function _wireList() {
  _bodyEl.querySelector('#sp-new')?.addEventListener('click', () => {
    const cmd = new ShaderCreateCommand({ name: 'Material', type: 'standard' });
    push(cmd);
    _editingId = cmd.getNewId();
    _render();
  });

  _bodyEl.querySelectorAll('.sp-row').forEach(row => {
    const activate = (e) => {
      // Row-action buttons own their own clicks (duplicate, etc.).
      const dupBtn = e.target.closest?.('[data-sp-dup]');
      if (dupBtn) {
        e.stopPropagation();
        const cmd = new ShaderDuplicateCommand(dupBtn.dataset.spDup);
        push(cmd);
        const id = cmd.getNewId();
        if (id) _editingId = id;
        _render();
        return;
      }
      _editingId = row.dataset.shaderId;
      _render();
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      activate(e);
    });
    row.addEventListener('dragstart', (e) => {
      const shaderId = row.dataset.shaderId;
      const sh = getState().scene.shaders[shaderId];
      if (!sh) return;
      e.dataTransfer.setData(SHADER_DRAG_MIME, JSON.stringify({ shaderId }));
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
}

// ── Editor ───────────────────────────────────────────────

function _renderEditorEmpty() {
  return `
    <section class="sp-section" data-section="editor">
      <header class="sp-section-header"><span>Editor</span></header>
      <div class="sp-empty">Select a shader above to edit it.</div>
    </section>
  `;
}

function _renderEditor(sh) {
  const isPBR  = sh.type === 'pbr';
  const opPct  = Math.round((sh.opacity ?? 1) * 100);
  const linked = sh.linkedMeshIds.length;
  const selCount = Selection.getSelectedIds().length;

  return `
    <section class="sp-section" data-section="editor">
      <header class="sp-section-header"><span>Editor</span></header>

      <div class="sp-row-form">
        <label>Name</label>
        <input type="text" id="sp-edit-name" value="${escapeAttr(sh.name)}">
      </div>

      <div class="sp-row-form">
        <label>Type</label>
        <select id="sp-edit-type">
          <option value="standard" ${sh.type === 'standard' ? 'selected' : ''}>Standard</option>
          <option value="pbr"      ${sh.type === 'pbr'      ? 'selected' : ''}>PBR</option>
          <option value="unlit"    ${sh.type === 'unlit'    ? 'selected' : ''}>Unlit</option>
        </select>
      </div>

      <div class="sp-row-form">
        <label>Color</label>
        <div class="sp-color-line">
          <input type="color" id="sp-edit-color" value="${escapeAttr(_safeHex(sh.diffuseColor))}">
          <input type="text"  id="sp-edit-color-hex" value="${escapeAttr(_safeHex(sh.diffuseColor))}" spellcheck="false">
        </div>
      </div>

      <div class="sp-row-form">
        <label>Texture</label>
        <div class="sp-tex-drop" id="sp-edit-tex" data-shader-id="${escapeAttr(sh.id)}">
          ${_renderTextureSlot(sh)}
        </div>
      </div>

      <div class="sp-row-form sp-slider-row">
        <label>Opacity</label>
        <input type="range" min="0" max="100" value="${opPct}" id="sp-edit-opacity">
        <span class="sp-readout">${opPct}%</span>
      </div>

      ${isPBR ? `
      <div class="sp-row-form sp-slider-row">
        <label>Roughness</label>
        <input type="range" min="0" max="100" value="${Math.round((sh.roughness ?? 0.5) * 100)}" id="sp-edit-rough">
        <span class="sp-readout">${Math.round((sh.roughness ?? 0.5) * 100)}%</span>
      </div>
      <div class="sp-row-form sp-slider-row">
        <label>Metallic</label>
        <input type="range" min="0" max="100" value="${Math.round((sh.metallic ?? 0) * 100)}" id="sp-edit-metal">
        <span class="sp-readout">${Math.round((sh.metallic ?? 0) * 100)}%</span>
      </div>
      ` : ''}

      <div class="sp-uv-grid">
        <span class="sp-uv-label">UV base</span>
        <span class="sp-uv-cell"><label>U off</label><input type="number" step="0.01" id="sp-uv-ox" value="${_fmt(sh.uvBase.offsetX, 3)}"></span>
        <span class="sp-uv-cell"><label>V off</label><input type="number" step="0.01" id="sp-uv-oy" value="${_fmt(sh.uvBase.offsetY, 3)}"></span>
        <span class="sp-uv-cell"><label>U scale</label><input type="number" step="0.1" id="sp-uv-sx" value="${_fmt(sh.uvBase.scaleX, 3)}"></span>
        <span class="sp-uv-cell"><label>V scale</label><input type="number" step="0.1" id="sp-uv-sy" value="${_fmt(sh.uvBase.scaleY, 3)}"></span>
        <span class="sp-uv-cell"><label>Rot (rad)</label><input type="number" step="0.1" id="sp-uv-rot" value="${_fmt(sh.uvBase.rotation, 3)}"></span>
      </div>

      <div class="sp-actions">
        <button class="sp-btn" id="sp-act-duplicate">${icon('Copy',  { width: 12, height: 12 })}<span>Duplicate</span></button>
        <button class="sp-btn" id="sp-act-assign" ${selCount ? '' : 'disabled'}>${icon('Link', { width: 12, height: 12 })}<span>Assign (${selCount})</span></button>
        <button class="sp-btn" id="sp-act-select" ${linked ? '' : 'disabled'}>${icon('Focus', { width: 12, height: 12 })}<span>Select linked</span></button>
        <button class="sp-btn sp-btn-danger" id="sp-act-delete" ${linked ? 'disabled' : ''} title="${escapeAttr(linked ? `Refuses while ${linked} mesh${linked === 1 ? '' : 'es'} use this shader` : 'Delete shader')}">${icon('Trash2', { width: 12, height: 12 })}<span>Delete</span></button>
      </div>
    </section>
  `;
}

function _renderTextureSlot(sh) {
  if (!sh.diffuseTextureAssetId) {
    return `
      <span class="sp-tex-empty">
        ${icon('Image', { width: 14, height: 14 })}
        <span>Drop image here</span>
        <button class="sp-tex-pick" id="sp-tex-pick" type="button" title="Pick from loaded textures">Pick…</button>
      </span>
    `;
  }
  const asset = getState().scene.assetLibrary[sh.diffuseTextureAssetId];
  if (!asset) {
    return `<span class="sp-tex-empty">${icon('AlertTriangle', { width: 14, height: 14 })}<span>Missing</span></span>`;
  }
  const thumbSrc = safeImageSrc(asset.thumbnailDataUrl);
  return `
    <span class="sp-tex-loaded" title="${escapeAttr(asset.filename)}">
      ${thumbSrc ? `<img src="${thumbSrc}" alt="">` : `<span class="sp-tex-thumb-empty">${icon('Image', { width: 14, height: 14 })}</span>`}
      <span class="sp-tex-name">${_escape(asset.name)}</span>
      <button class="sp-tex-pick" id="sp-tex-pick" type="button" title="Pick another texture">Swap…</button>
      <button class="sp-tex-clear" id="sp-tex-clear" title="Remove texture">×</button>
    </span>
  `;
}

function _wireEditor(shaderId) {
  const sh = getState().scene.shaders[shaderId];
  if (!sh) return;

  // Text fields commit on change (blur/Enter); ColorApply / slider commits on change too.
  _bindShaderField('sp-edit-name', 'name', shaderId, v => String(v));
  _bindShaderField('sp-edit-type', 'type', shaderId, v => v);

  const colorEl    = _bodyEl.querySelector('#sp-edit-color');
  const colorHexEl = _bodyEl.querySelector('#sp-edit-color-hex');
  const commitColor = (next) => {
    if (!/^#[0-9a-fA-F]{6}$/.test(next)) return;
    if (next.toLowerCase() === sh.diffuseColor.toLowerCase()) return;
    push(new ColorApplyCommand(shaderId, sh.diffuseColor, next));
  };
  colorEl?.addEventListener('change', () => commitColor(colorEl.value));
  colorHexEl?.addEventListener('change', () => commitColor(colorHexEl.value.trim()));

  _bindShaderSlider('sp-edit-opacity', 'opacity', shaderId, v => v / 100);
  _bindShaderSlider('sp-edit-rough',   'roughness', shaderId, v => v / 100);
  _bindShaderSlider('sp-edit-metal',   'metallic',  shaderId, v => v / 100);

  // UV base — gather all five inputs and push one ShaderUpdateCommand per change.
  const uvFields = [
    ['sp-uv-ox', 'offsetX'],
    ['sp-uv-oy', 'offsetY'],
    ['sp-uv-sx', 'scaleX'],
    ['sp-uv-sy', 'scaleY'],
    ['sp-uv-rot', 'rotation'],
  ];
  for (const [elId, key] of uvFields) {
    const el = _bodyEl.querySelector(`#${elId}`);
    el?.addEventListener('change', () => {
      const n = parseFloat(el.value);
      if (!Number.isFinite(n)) { _render(); return; }
      const prevUV = { ...getState().scene.shaders[shaderId].uvBase };
      if (Math.abs(prevUV[key] - n) < 1e-9) return;
      const nextUV = { ...prevUV, [key]: n };
      push(new ShaderUpdateCommand(shaderId, 'uvBase', prevUV, nextUV));
    });
  }

  // Texture drop-target
  const texEl = _bodyEl.querySelector('#sp-edit-tex');
  if (texEl) {
    texEl.addEventListener('dragover', e => {
      if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
      e.preventDefault();
      texEl.classList.add('sp-tex-dragover');
    });
    texEl.addEventListener('dragleave', () => texEl.classList.remove('sp-tex-dragover'));
    texEl.addEventListener('drop', e => {
      texEl.classList.remove('sp-tex-dragover');
      const raw = e.dataTransfer.getData(DRAG_MIME);
      if (!raw) return;
      let payload; try { payload = JSON.parse(raw); } catch { return; }
      if (payload.kind !== 'texture') {
        Toast.show('Only image files can be dropped here', 'warning', 3000);
        return;
      }
      e.preventDefault();
      _assignTextureFromPayload(shaderId, payload);
    });
  }
  _bodyEl.querySelector('#sp-tex-clear')?.addEventListener('click', () => {
    _clearTexture(shaderId);
  });
  _bodyEl.querySelector('#sp-tex-pick')?.addEventListener('click', () => {
    _openTexturePicker(shaderId);
  });

  // Action buttons
  _bodyEl.querySelector('#sp-act-duplicate')?.addEventListener('click', () => {
    const cmd = new ShaderDuplicateCommand(shaderId);
    push(cmd);
    const newId = cmd.getNewId();
    if (newId) _editingId = newId;
    _render();
  });

  _bodyEl.querySelector('#sp-act-assign')?.addEventListener('click', () => {
    const ids = Selection.getSelectedIds();
    if (!ids.length) return;
    push(new ShaderAssignCommand(ids, shaderId));
  });

  _bodyEl.querySelector('#sp-act-select')?.addEventListener('click', () => {
    const linked = sh.linkedMeshIds;
    if (!linked.length) return;
    Selection.set(linked, linked[linked.length - 1]);
  });

  _bodyEl.querySelector('#sp-act-delete')?.addEventListener('click', () => {
    if (sh.linkedMeshIds.length > 0) {
      Toast.show(`Reassign ${sh.linkedMeshIds.length} mesh${sh.linkedMeshIds.length === 1 ? '' : 'es'} first`, 'warning', 3000);
      return;
    }
    push(new ShaderDeleteCommand(shaderId));
    _editingId = null;
    _render();
  });
}

function _bindShaderField(elId, field, shaderId, coerce) {
  const el = _bodyEl.querySelector(`#${elId}`);
  if (!el) return;
  el.addEventListener('change', () => {
    const sh = getState().scene.shaders[shaderId];
    if (!sh) return;
    const next = coerce(el.value);
    if (next === sh[field]) return;
    push(new ShaderUpdateCommand(shaderId, field, sh[field], next));
  });
}

function _bindShaderSlider(elId, field, shaderId, coerce) {
  const el = _bodyEl.querySelector(`#${elId}`);
  if (!el) return;
  // Re-render the small "%" readout live while dragging, but only commit
  // on `change` (mouseup) so we don't flood undo with intermediate values.
  el.addEventListener('input', () => {
    const out = el.parentElement?.querySelector('.sp-readout');
    if (out) out.textContent = `${el.value}%`;
  });
  el.addEventListener('change', () => {
    const sh = getState().scene.shaders[shaderId];
    if (!sh) return;
    const next = coerce(parseFloat(el.value));
    if (!Number.isFinite(next)) return;
    if (Math.abs(sh[field] - next) < 1e-6) return;
    push(new ShaderUpdateCommand(shaderId, field, sh[field], next));
  });
}

async function _assignTextureFromPayload(shaderId, payload) {
  await safeAsync(async () => {
    let assetId = null;
    if (payload.mountKey === SESSION_KEY) {
      // Already-loaded session/imported texture — `path` is the assetId.
      assetId = payload.path;
    } else {
      const handle = AssetPanel.getFileHandle(payload.mountKey, payload.path);
      if (!handle) throw new Error('Texture file handle not available');
      assetId = await AssetLoader.loadTextureFromHandle(handle, {
        directoryHandleKey: payload.mountKey, originalPath: payload.path,
      });
    }
    if (!assetId) return;
    const sh = getState().scene.shaders[shaderId];
    if (!sh) return;
    // updateShader inside the command syncs the Babylon material for us.
    push(new ShaderUpdateCommand(shaderId, 'diffuseTextureAssetId', sh.diffuseTextureAssetId, assetId));
  });
}

function _clearTexture(shaderId) {
  const sh = getState().scene.shaders[shaderId];
  if (!sh?.diffuseTextureAssetId) return;
  push(new ShaderUpdateCommand(shaderId, 'diffuseTextureAssetId', sh.diffuseTextureAssetId, null));
}

// ── Swatch palette ───────────────────────────────────────

function _renderSwatches() {
  const userSwatches = getState().scene.userSwatches ?? [];
  const groups = _groupByCategory(DEFAULT_SWATCHES);
  const groupHtml = Object.entries(groups).map(([cat, swatches]) => `
    <div class="sp-swatch-group">
      <header class="sp-swatch-cat">${_escape(cat)}</header>
      <div class="sp-swatch-grid">
        ${swatches.map(_renderSwatchChip).join('')}
      </div>
    </div>
  `).join('');

  const userHtml = `
    <div class="sp-swatch-group">
      <header class="sp-swatch-cat">User
        <button class="sp-icon-btn" id="sp-add-swatch" title="Save current color as swatch">${icon('Plus', { width: 12, height: 12 })}</button>
      </header>
      <div class="sp-swatch-grid">
        ${userSwatches.map(_renderSwatchChip).join('')}
        ${userSwatches.length === 0 ? '<span class="sp-swatch-hint">Click + to save the active shader\'s color.</span>' : ''}
      </div>
    </div>
  `;

  return `
    <section class="sp-section" data-section="swatches">
      <header class="sp-section-header">
        <span>${icon('Palette', { width: 14, height: 14 })} Swatches</span>
      </header>
      ${groupHtml}
      ${userHtml}
    </section>
  `;
}

function _renderSwatchChip(sw) {
  return `
    <button class="sp-swatch"
            data-hex="${escapeAttr(_safeHex(sw.hex))}"
            title="${escapeAttr(`${sw.name} - ${_safeHex(sw.hex)}`)}"
            style="background:${_safeHex(sw.hex)}">
    </button>
  `;
}

function _wireSwatches() {
  _bodyEl.querySelectorAll('.sp-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!_editingId) {
        Toast.show('Select a shader first', 'info', 2000);
        return;
      }
      const hex = btn.dataset.hex;
      const sh = getState().scene.shaders[_editingId];
      if (!sh || hex.toLowerCase() === sh.diffuseColor.toLowerCase()) return;
      push(new ColorApplyCommand(_editingId, sh.diffuseColor, hex));
    });
  });

  _bodyEl.querySelector('#sp-add-swatch')?.addEventListener('click', () => {
    if (!_editingId) {
      Toast.show('Select a shader first', 'info', 2000);
      return;
    }
    const sh = getState().scene.shaders[_editingId];
    if (!sh) return;
    _addUserSwatch(sh.name, sh.diffuseColor);
  });
}

function _addUserSwatch(name, hex) {
  // Phase 4 milestone keeps user-swatch CRUD outside the history stack —
  // these are personal presets, not project state. Persistence will land
  // alongside autosave in Phase 6.
  const id = `usw_${Date.now().toString(36)}`;
  const swatch = { id, name, hex, category: 'User' };
  setState(s => ({
    ...s,
    scene: { ...s.scene, userSwatches: [...(s.scene.userSwatches ?? []), swatch] },
  }), { silent: true });
  _render();
}

function _groupByCategory(swatches) {
  const out = {};
  for (const sw of swatches) {
    (out[sw.category] ??= []).push(sw);
  }
  return out;
}

// ── Helpers ──────────────────────────────────────────────

function _fmt(n, dp = 2) {
  return Number.isFinite(n) ? Number(n.toFixed(dp)).toString() : '0';
}

function _safeHex(value) {
  const hex = String(value ?? '').trim();
  return /^#[0-9a-f]{6}$/i.test(hex) ? hex : '#9ca3af';
}

/**
 * Open `shaderId` in the editor and expand the Shaders section if collapsed.
 * Used by PropertiesPanel's "Edit" button.
 * @param {string} shaderId
 */
export function focus(shaderId) {
  if (!getState().scene.shaders[shaderId]) return;
  _editingId = shaderId;
  document.getElementById('rp-shaders')?.classList.remove('collapsed');
  _render();
}

export const ShaderPanel = { init, focus };
