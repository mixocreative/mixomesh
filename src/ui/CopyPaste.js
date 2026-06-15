// Copy / Paste with an aspect chooser (Blender-ish, MIXOMESH twist).
//
// Ctrl+C → pick what to copy from the ACTIVE object (Object / Location /
// Rotation / Scale / Location+Rotation / All) → stored in an in-app clipboard.
// Ctrl+V → pick what to paste (only aspects present in the clipboard) → applied
// to every selected object as one undoable step ("Object" duplicates the
// source). Multi-select "copy from active to the others" falls out for free:
// select N, Ctrl+C (All), Ctrl+V (All) lands the active's transform on the rest.

import { Selection } from '../core/Selection.js';
import { AssetLoader } from '../core/AssetLoader.js';
import { getState } from '../core/StateManager.js';
import { push, TransformCommand, DuplicateCommand } from '../core/HistoryManager.js';
import { captureWorld } from '../core/commands/support.js';
import { logicalObjectCommandIds } from '../core/LogicalObjects.js';
import { InputManager } from '../core/InputManager.js';
import { Toast } from './Toast.js';
import { icon } from '../core/Icons.js';
import { escapeHtml } from './renderSafe.js';
import { t } from '../i18n/index.js';

// clipboard: { transform: {position,rotation,scaling}, has:{position,rotation,scaling}, sourceId }
let _clip = null;
let _menuEl = null;
let _lastMouse = { x: window.innerWidth / 2, y: window.innerHeight / 2 };

// Aspect → { label, icon, needs:[flag…], object? }. `needs` lists which clipboard
// `has` flags must be set for the paste option to appear.
const ASPECTS = [
  { key: 'object',  label: 'Object',              iconName: 'Copy',     object: true },
  { key: 'all',     label: 'All',                 iconName: 'Layers',   needs: ['position', 'rotation', 'scaling'] },
  { key: 'loc-rot', label: 'Location + Rotation', iconName: 'Move3D',   needs: ['position', 'rotation'] },
  { key: 'location',label: 'Location',            iconName: 'Move',     needs: ['position'] },
  { key: 'rotation',label: 'Rotation',            iconName: 'RotateCw', needs: ['rotation'] },
  { key: 'scale',   label: 'Scale',               iconName: 'Scale3D',  needs: ['scaling'] },
];

export function init() {
  document.addEventListener('mousemove', (e) => { _lastMouse = { x: e.clientX, y: e.clientY }; });
  InputManager.register('Ctrl+C', 'viewport', _copy);
  InputManager.register('Ctrl+V', 'viewport', _paste);
}

// ── Copy ─────────────────────────────────────────────────

function _copy() {
  const activeId = Selection.getActiveId();
  if (!activeId) { Toast.show(t('toast.selectToCopy'), 'info', 2000); return; }
  const mesh = AssetLoader.getBabylonMesh(activeId);
  if (!mesh) return;

  // Copy chooser offers every aspect (the active always has a full transform).
  _openChooser(ASPECTS.map(a => a.key), (key) => {
    const xform = captureWorld(mesh);
    const has = { position: false, rotation: false, scaling: false };
    if (key === 'object' || key === 'all') { has.position = has.rotation = has.scaling = true; }
    else if (key === 'loc-rot') { has.position = has.rotation = true; }
    else if (key === 'location') has.position = true;
    else if (key === 'rotation') has.rotation = true;
    else if (key === 'scale')    has.scaling  = true;

    _clip = { transform: xform, has, sourceId: key === 'object' ? activeId : null };
    const label = ASPECTS.find(a => a.key === key)?.label ?? key;
    Toast.show(t('toast.copied', { label }), 'success', 1600);
  });
}

// ── Paste ────────────────────────────────────────────────

function _paste() {
  if (!_clip) { Toast.show(t('toast.clipboardEmpty'), 'info', 2000); return; }

  // Offer only aspects the clipboard can satisfy.
  const avail = ASPECTS.filter(a =>
    (a.object && _clip.sourceId) ||
    (a.needs && a.needs.every(f => _clip.has[f]))
  ).map(a => a.key);
  if (!avail.length) { Toast.show(t('toast.nothingToPaste'), 'info', 2000); return; }

  _openChooser(avail, (key) => {
    if (key === 'object') { _pasteObject(); return; }
    _pasteTransform(key);
  });
}

function _pasteObject() {
  if (!_clip?.sourceId) return;
  if (!getState().scene.objects[_clip.sourceId]) { Toast.show(t('toast.sourceGone'), 'info', 2000); return; }
  push(new DuplicateCommand([_clip.sourceId]));
}

function _pasteTransform(key) {
  const ids = logicalObjectCommandIds(Selection.getSelectedIds(), getState().scene.objects);
  if (!ids.length) { Toast.show(t('toast.selectTarget'), 'info', 2000); return; }

  const want = {
    position: key === 'all' || key === 'loc-rot' || key === 'location',
    rotation: key === 'all' || key === 'loc-rot' || key === 'rotation',
    scaling:  key === 'all' || key === 'scale',
  };
  const src = _clip.transform;
  const prev = {}, next = {};
  for (const id of ids) {
    const m = AssetLoader.getBabylonMesh(id);
    if (!m) continue;
    const cur = captureWorld(m);
    prev[id] = cur;
    next[id] = {
      position: want.position ? { ...src.position } : { ...cur.position },
      rotation: want.rotation ? { ...src.rotation } : { ...cur.rotation },
      scaling:  want.scaling  ? { ...src.scaling }  : { ...cur.scaling },
    };
  }
  if (!Object.keys(next).length) return;
  push(new TransformCommand(prev, next));
}

// ── Aspect chooser popup (reuses .context-menu styling) ──

function _openChooser(keys, onPick) {
  _closeChooser();
  const items = ASPECTS.filter(a => keys.includes(a.key));
  _menuEl = document.createElement('div');
  _menuEl.className = 'context-menu';
  _menuEl.setAttribute('role', 'menu');
  _menuEl.innerHTML = items.map(a => `
    <div class="cm-item" data-key="${a.key}" role="menuitem" tabindex="0">
      <span class="cm-icon">${icon(a.iconName, { width: 13, height: 13 })}</span>
      <span class="cm-label">${escapeHtml(a.label)}</span>
    </div>
  `).join('');
  document.body.appendChild(_menuEl);
  _menuEl.style.left = `${_lastMouse.x}px`;
  _menuEl.style.top  = `${_lastMouse.y}px`;

  // Edge-clamp after layout.
  requestAnimationFrame(() => {
    if (!_menuEl) return;
    const r = _menuEl.getBoundingClientRect();
    if (r.right  > window.innerWidth)  _menuEl.style.left = `${Math.max(0, window.innerWidth  - r.width  - 4)}px`;
    if (r.bottom > window.innerHeight) _menuEl.style.top  = `${Math.max(0, window.innerHeight - r.height - 4)}px`;
    _menuEl.querySelector('.cm-item')?.focus();
  });

  const pick = (key) => { _closeChooser(); onPick(key); };
  _menuEl.querySelectorAll('[data-key]').forEach(el => {
    el.addEventListener('click', () => pick(el.dataset.key));
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(el.dataset.key); }
    });
  });

  // Dismiss on outside pointer / Escape (capture so it beats canvas handlers).
  setTimeout(() => {
    document.addEventListener('pointerdown', _outsideClose, true);
    document.addEventListener('keydown', _escClose, true);
  }, 0);
}

function _outsideClose(e) {
  if (_menuEl && !_menuEl.contains(e.target)) _closeChooser();
}
function _escClose(e) {
  if (e.key === 'Escape') { e.preventDefault(); _closeChooser(); }
}
function _closeChooser() {
  document.removeEventListener('pointerdown', _outsideClose, true);
  document.removeEventListener('keydown', _escClose, true);
  if (_menuEl) { _menuEl.remove(); _menuEl = null; }
}

export const CopyPaste = { init };
