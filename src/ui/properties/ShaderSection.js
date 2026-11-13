// The Properties panel's shader slot list, and the picker modal it opens.
//
// A slot is one distinct shader currently bound to the selected meshes, the active mesh's bucket
// first. A slot can focus its shader in the Library, replace the binding, or duplicate the shader
// in place (clone + reassign as ONE undo entry -- `beginBatch`/`endBatch` below, and getting that
// wrong gives the user an undo that half-undoes).
//
// What this module deliberately does NOT do: edit a shader's appearance. Colour, texture, sliders
// and UV base are edited only in the Shader Library, and auto-focus brings the active mesh's
// shader into that editor. Two places to change a colour is two answers to what colour it is.
//
// Cut out of PropertiesPanel.js on 2026-11-14 (253 lines). The boundary was already clean: the
// panel needed three functions from this block and the block needed one DOM element and one
// helper, so `wireShaderSection` now TAKES the element instead of reading module scope, and the
// helper moved to ./targets.js where the scale rows use it too.

import { getState } from '../../core/StateManager.js';
import { t } from '../../i18n/index.js';
import { Selection } from '../../core/Selection.js';
import {
  push, beginBatch, endBatch, ShaderAssignCommand, ShaderDuplicateCommand,
} from '../../core/HistoryManager.js';
import { ShaderPanel, renderShaderPreview } from '../ShaderPanel.js';
import { Modal } from '../Modal.js';
import { icon, sectionIcon } from '../../core/Icons.js';
import { escapeHtml as _escape, escapeAttr } from '../renderSafe.js';
import { logicalTargetIds } from './targets.js';

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
export function renderShaderSection(obj) {
  const libShaders = Object.values(getState().scene.shaders);
  if (!libShaders.length) {
    return `
      <section class="pp-section" data-section="shader">
        <header class="pp-section-header">${sectionIcon('Brush')}<span data-i18n-key="section.shader">Shader</span></header>
        <div class="pp-row pp-row-inline">
          <span class="pp-hint">${_escape(t('properties.noShaders'))}</span>
        </div>
      </section>
    `;
  }

  const activeId = Selection.getActiveId();
  const selIds   = Selection.getSelectedResolved().map(r => r.id);
  const meshIds  = selIds.length ? selIds : logicalTargetIds(obj.id);

  // Buckets by shader, then re-ordered so the active mesh's bucket is first.
  const buckets = _collectShaderBuckets(meshIds);
  const activeBucketIdx = buckets.findIndex(b => b.meshIds.includes(activeId));
  if (activeBucketIdx > 0) {
    const [active] = buckets.splice(activeBucketIdx, 1);
    buckets.unshift(active);
  }

  const slotsHtml = buckets.map(b => _renderShaderSlot(b, libShaders)).join('');

  // ↧ Copy-from-active: visible when multi-select AND the active mesh has a
  // shader to propagate. Reassigns every other selected mesh's binding to the
  // active's shader in one undo step.
  const activeObj = activeId ? getState().scene.objects[activeId] : null;
  const canCopy = meshIds.length > 1 && activeObj?.shaderId;
  const copyBtn = canCopy
    ? `<button class="pp-copy-btn" data-copy="shader" title="${escapeAttr(t('properties.copyShaderTitle'))}">↧</button>`
    : '';

  return `
    <section class="pp-section" data-section="shader">
      <header class="pp-section-header">
        ${sectionIcon('Brush')}<span data-i18n-key="section.shader">Shader</span>${copyBtn}
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

function _renderShaderSlot(bucket /*, libShaders */) {
  // Empty bucket — meshes with no shader bound. One [Assign…] button opens
  // the picker modal (no Duplicate — nothing to clone from).
  if (!bucket.shaderId) {
    return `
      <div class="pp-shader-slot pp-shader-slot-empty"
           data-bucket-shader=""
           data-bucket-meshes="${escapeAttr(bucket.meshIds.join(','))}">
        <span class="pp-shader-chip pp-shader-chip-empty">${icon('AlertTriangle', { width: 12, height: 12 })}</span>
        <span class="pp-shader-name">${_escape(t('properties.noShader'))}</span>
        <span class="pp-shader-meshcount">${bucket.meshIds.length}</span>
        <button class="pp-slot-action" data-slot-assign type="button" title="${escapeAttr(t('properties.assignShaderTitle'))}">${_escape(t('properties.assign'))}</button>
      </div>
    `;
  }

  const sh = getState().scene.shaders[bucket.shaderId];
  if (!sh) return '';

  return `
    <div class="pp-shader-slot"
         data-bucket-shader="${escapeAttr(sh.id)}"
         data-bucket-meshes="${escapeAttr(bucket.meshIds.join(','))}">
      <button class="pp-slot-info" type="button" data-slot-focus="${escapeAttr(sh.id)}"
              title="${escapeAttr(t('properties.openShaderTitle', { name: sh.name }))}">
        ${renderShaderPreview(sh, 18)}
        <span class="pp-shader-name">${_escape(sh.name)}</span>
        <span class="pp-shader-meshcount" title="${escapeAttr(t('properties.meshCountInSelection', { n: bucket.meshIds.length }))}">${bucket.meshIds.length}</span>
      </button>
      <button class="pp-slot-action pp-slot-icon" data-slot-dup="${escapeAttr(sh.id)}" type="button" title="${escapeAttr(t('properties.duplicateInPlace'))}">${icon('Copy', { width: 13, height: 13 })}</button>
      <button class="pp-slot-action" data-slot-replace="${escapeAttr(sh.id)}" type="button" title="${escapeAttr(t('properties.replaceShaderTitle'))}">${_escape(t('properties.replace'))}</button>
    </div>
  `;
}

export function wireShaderSection(bodyEl) {
  // Slot click → focus the shader in the Library (replaces the old Edit button).
  bodyEl.querySelectorAll('[data-slot-focus]').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.slotFocus;
      if (id) ShaderPanel.focus(id);
    });
  });

  // Duplicate-in-place: clone source shader + reassign to bucket's meshes.
  bodyEl.querySelectorAll('[data-slot-dup]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sourceId = btn.dataset.slotDup;
      const slot = btn.closest('.pp-shader-slot');
      const targets = (slot?.dataset.bucketMeshes ?? '').split(',').filter(Boolean);
      if (!sourceId || !targets.length) return;
      beginBatch('Duplicate Shader in Place');
      const dup = new ShaderDuplicateCommand(sourceId);
      push(dup);
      const newId = dup.getNewId();
      if (newId) push(new ShaderAssignCommand(targets, newId));
      endBatch();
      if (newId) ShaderPanel.focus(newId);
    });
  });

  // Replace…: open shader picker modal with the bucket's current shader excluded.
  bodyEl.querySelectorAll('[data-slot-replace]').forEach(btn => {
    btn.addEventListener('click', () => {
      const sourceId = btn.dataset.slotReplace;
      const slot = btn.closest('.pp-shader-slot');
      const targets = (slot?.dataset.bucketMeshes ?? '').split(',').filter(Boolean);
      if (!targets.length) return;
      Modal.open('shader-picker', {
        excludeShaderId: sourceId,
        title: t('properties.replaceShader'),
        onClose: (nextId) => {
          if (!nextId || nextId === sourceId) return;
          push(new ShaderAssignCommand(targets, nextId));
        },
      });
    });
  });

  // Assign…: empty-bucket variant, same picker, no exclusion.
  bodyEl.querySelectorAll('[data-slot-assign]').forEach(btn => {
    btn.addEventListener('click', () => {
      const slot = btn.closest('.pp-shader-slot');
      const targets = (slot?.dataset.bucketMeshes ?? '').split(',').filter(Boolean);
      if (!targets.length) return;
      Modal.open('shader-picker', {
        excludeShaderId: null,
        title: t('properties.assignShader'),
        onClose: (nextId) => {
          if (!nextId) return;
          push(new ShaderAssignCommand(targets, nextId));
        },
      });
    });
  });

  bodyEl.querySelector('[data-copy="shader"]')?.addEventListener('click', (e) => {
    e.stopPropagation();   // header click toggles section collapse; copy must not
    _copyShaderFromActive();
  });
}

/**
 * Propagate the active mesh's shader binding to every OTHER selected mesh.
 * `ShaderAssignCommand` is natively multi-mesh, so one push = one undo step.
 * Skips meshes already bound to the active shader (no-op edges).
 */
function _copyShaderFromActive() {
  const activeId = Selection.getActiveId();
  const selIds = Selection.getSelectedIds();
  if (!activeId || selIds.length < 2) return;
  const objects = getState().scene.objects;
  const activeObj = objects[activeId];
  if (!activeObj?.shaderId) return;
  const targets = selIds.filter(id => {
    if (id === activeId) return false;
    const o = objects[id];
    return o && o.shaderId !== activeObj.shaderId;
  });
  if (!targets.length) return;
  push(new ShaderAssignCommand(targets, activeObj.shaderId));
}

// Shader picker modal renderer: searchable thumbnail grid driven by
// state.scene.shaders. Closes with the picked shader id (or null on cancel).
export function shaderPickerRenderer({ data, close }) {
  const excludeId = data?.excludeShaderId ?? null;
  const title = data?.title ?? t('properties.pickShader');
  const root = document.createElement('div');
  root.className = 'modal-shader-picker';
  let query = '';

  const render = () => {
    const all = Object.values(getState().scene.shaders);
    const q = query.trim().toLowerCase();
    const filtered = all
      .filter(s => s.id !== excludeId)
      .filter(s => !q || s.name.toLowerCase().includes(q));

    root.innerHTML = `
      <header class="modal-header">
        <h3>${_escape(title)}</h3>
        <button class="modal-close" data-action="cancel" type="button" aria-label="${escapeAttr(t('btn.close'))}">×</button>
      </header>
      <div class="modal-shader-picker-search">
        <input type="search" placeholder="${escapeAttr(t('properties.searchShaders'))}" value="${escapeAttr(query)}" autocomplete="off">
      </div>
      <div class="modal-shader-picker-grid">
        ${filtered.length ? filtered.map(s => `
          <button class="modal-shader-tile" data-shader-id="${escapeAttr(s.id)}" type="button" title="${escapeAttr(s.name)}">
            ${renderShaderPreview(s, 72)}
            <span class="modal-shader-tile-name">${_escape(s.name)}</span>
          </button>
        `).join('') : `<div class="modal-empty">${_escape(t('properties.noShadersMatch'))}</div>`}
      </div>
      <footer class="modal-footer">
        <button class="modal-btn" data-action="cancel" type="button">${_escape(t('btn.cancel'))}</button>
      </footer>
    `;

    const search = root.querySelector('input[type="search"]');
    search?.addEventListener('input', (e) => {
      query = e.target.value;
      render();
    });
    root.querySelectorAll('[data-shader-id]').forEach(tile => {
      tile.addEventListener('click', () => close(tile.dataset.shaderId));
    });
    root.querySelectorAll('[data-action="cancel"]').forEach(b => {
      b.addEventListener('click', () => close(null));
    });
    search?.focus();
  };
  render();
  return root;
}
