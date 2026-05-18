import { Toast } from './ui/Toast.js';
import { StatusBar } from './ui/StatusBar.js';
import { SceneManager } from './core/SceneManager.js';
import { getState } from './core/StateManager.js';
import { InputManager } from './core/InputManager.js';
import { AssetPanel } from './ui/AssetPanel.js';
import { ViewportDrop } from './ui/ViewportDrop.js';
import { Outliner } from './ui/Outliner.js';
import { PropertiesPanel } from './ui/PropertiesPanel.js';
import { ShaderPanel } from './ui/ShaderPanel.js';
import { PrintPanel } from './ui/PrintPanel.js';
import { ContextMenu } from './ui/ContextMenu.js';
import { Modal } from './ui/Modal.js';
import { ViewportToolbar } from './ui/ViewportToolbar.js';
import { NavCube } from './ui/NavCube.js';
import { push, TransformCommand } from './core/HistoryManager.js';
import { PersistenceManager } from './core/PersistenceManager.js';
import { ProjectMenu } from './ui/ProjectMenu.js';
import { safeAsync } from './ui/Toast.js';
import { icon } from './core/Icons.js';

// ── Browser gate ─────────────────────────────────────────
if (!('showDirectoryPicker' in window)) {
  document.body.innerHTML = `
    <div style="
      display:flex;align-items:center;justify-content:center;
      height:100vh;font-family:system-ui;color:#ededf0;
      background:#0a0a0b;text-align:center;padding:2rem;
    ">
      <div>
        <p style="font-size:1.2rem;margin-bottom:.5rem">Browser not supported</p>
        <p style="color:#a1a1ab;font-size:.9rem">MIXOMESH requires Chrome or Edge (File System Access API).</p>
      </div>
    </div>`;
  throw new Error('Unsupported browser — Chrome/Edge required');
}

// ── Bootstrap ─────────────────────────────────────────────
async function bootstrap() {
  Toast.init();
  StatusBar.init();

  const canvas = document.getElementById('renderCanvas');
  SceneManager.init(canvas);
  InputManager.init(SceneManager.getScene());

  // After-gizmo-drag → push TransformCommand. Injected here to avoid a
  // SceneManager → HistoryManager dependency cycle.
  SceneManager.setTransformCommitHandler(({ prev, next, alreadyApplied }) => {
    push(new TransformCommand(prev, next, { alreadyApplied }));
  });

  Modal.init();
  Outliner.init();
  PropertiesPanel.init();
  ShaderPanel.init();
  PrintPanel.init();
  ContextMenu.init();
  AssetPanel.init();
  ViewportToolbar.init();
  NavCube.init();
  PersistenceManager.init();
  ProjectMenu.init();
  _wireRightPanelCollapse();
  _initPanels();
  ViewportDrop.attach(document.getElementById('viewport'), SceneManager.getScene());

  // Both viewport RMB and outliner RMB route to the same context menu.
  InputManager.setContextMenuHandler((info) => ContextMenu.open(info));
  Outliner.setContextMenuHandler((info)     => ContextMenu.open(info));

  // Project shortcuts — override the InputManager no-op placeholders. The
  // dispatcher preventDefaults handled keys, so the browser's own Ctrl+S /
  // Ctrl+O dialogs stay suppressed.
  InputManager.register('Ctrl+S',       'global', () => safeAsync(() => PersistenceManager.save()));
  InputManager.register('Ctrl+Shift+S', 'global', () => safeAsync(() => PersistenceManager.saveAs()));
  InputManager.register('Ctrl+O',       'global', () => safeAsync(() => PersistenceManager.open()));
  InputManager.register('Ctrl+N',       'global', () => safeAsync(() => PersistenceManager.newProject()));

  // Apply boot overlays from initial state. printPreview defaults to ON
  // (Mimaki matte preview); wireframe edges + bedPreview default OFF.
  const overlays = getState().scene.overlays;
  for (const key of ['grid', 'axes', 'wireframe', 'printPreview', 'bedPreview']) {
    if (overlays?.[key]) SceneManager.setOverlay(key, true);
  }

  PersistenceManager.startAutosave();
  canvas.focus();

  // Boot: don't auto-recover a discarded session. Instead offer to re-mount
  // the last-used asset folder so saved projects relink to live files.
  safeAsync(() => AssetPanel.promptRemount());
}

function _wireRightPanelCollapse() {
  // Section headers carry data-toggle="<section-id>"; clicking flips a
  // .collapsed class on the parent <section>. Lightweight enough to live in
  // main.js — promote to a module if the pattern repeats elsewhere.
  document.querySelectorAll('#right-panel .rp-section-header').forEach(h => {
    h.addEventListener('click', () => {
      const sec = h.closest('.rp-section');
      sec?.classList.toggle('collapsed');
    });
  });

  // Vertical splitter — drag between Properties and Shader Library.
  // The top section's flex-basis switches from "fill share" to "fixed px"
  // once the user drags; the bottom keeps flex:1 so it absorbs the remainder.
  const splitter = document.querySelector('[data-rp-splitter]');
  const top      = document.getElementById('rp-properties');
  const panel    = document.getElementById('right-panel');
  if (!splitter || !top || !panel) return;

  const MIN_TOP = 80;
  const MIN_BOT = 80;
  let dragging = false;
  let startY = 0;
  let initialTopH = 0;
  let panelH = 0;

  splitter.addEventListener('pointerdown', (e) => {
    if (top.classList.contains('collapsed')) return;   // can't drag a collapsed section
    dragging = true;
    startY = e.clientY;
    initialTopH = top.getBoundingClientRect().height;
    panelH = panel.getBoundingClientRect().height;
    try { splitter.setPointerCapture(e.pointerId); } catch { /* */ }
    splitter.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });

  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    const maxTop = panelH - MIN_BOT - splitter.getBoundingClientRect().height;
    const newH = Math.max(MIN_TOP, Math.min(maxTop, initialTopH + dy));
    top.style.flex = `0 0 ${newH}px`;
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { splitter.releasePointerCapture(e.pointerId); } catch { /* */ }
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
  };
  splitter.addEventListener('pointerup',     endDrag);
  splitter.addEventListener('pointercancel', endDrag);
}

// ── Panel resize + collapse ────────────────────────────────

const _saved = { olWidth: 260, rpWidth: 300, apHeight: 220 };

function _initPanels() {
  const app = document.getElementById('app');
  const olEl = document.getElementById('outliner');
  const rpEl = document.getElementById('right-panel');
  const apEl = document.getElementById('asset-panel');

  const setVar  = (name, val) => app.style.setProperty(name, val + 'px');

  // ── Outliner right-edge resize + collapse ─────────────────
  olEl.style.position = 'relative';
  const olHandle = _addHandle(olEl, 'ew-right');
  _wireEW(olHandle, +1,
    () => olEl.getBoundingClientRect().width,
    (w) => setVar('--outliner-width', Math.max(140, Math.min(600, w))),
    () => olEl.classList.remove('ol-outer-collapsed'),
  );

  const olColBtn = _makeBtn(icon('ChevronLeft', { width: 13, height: 13 }), 'Collapse outliner', 'panel-collapse-btn');
  const olExpandStrip = document.createElement('div');
  olExpandStrip.className = 'ol-expand-strip';
  olExpandStrip.innerHTML = icon('ChevronRight', { width: 14, height: 14 });
  olExpandStrip.title = 'Expand outliner';
  olEl.appendChild(olExpandStrip);

  const olHeader = olEl.querySelector('.ol-header');
  if (olHeader) olHeader.appendChild(olColBtn);

  olColBtn.addEventListener('click', () => {
    _saved.olWidth = olEl.getBoundingClientRect().width;
    olEl.classList.add('ol-outer-collapsed');
    setVar('--outliner-width', 32);
  });
  olExpandStrip.addEventListener('click', () => {
    olEl.classList.remove('ol-outer-collapsed');
    setVar('--outliner-width', _saved.olWidth);
  });

  // ── Right panel left-edge resize + collapse ───────────────
  rpEl.style.position = 'relative';
  const rpHandle = _addHandle(rpEl, 'ew-left');
  _wireEW(rpHandle, -1,
    () => rpEl.getBoundingClientRect().width,
    (w) => setVar('--right-panel-width', Math.max(200, Math.min(600, w))),
    () => rpEl.classList.remove('rp-outer-collapsed'),
  );

  const rpColBtn = _makeBtn(icon('ChevronRight', { width: 13, height: 13 }), 'Collapse inspector', 'panel-collapse-btn');
  const rpExpandStrip = document.createElement('div');
  rpExpandStrip.className = 'rp-expand-strip';
  rpExpandStrip.innerHTML = icon('ChevronLeft', { width: 14, height: 14 });
  rpExpandStrip.title = 'Expand inspector';
  rpEl.appendChild(rpExpandStrip);

  const rpFirstHdr = rpEl.querySelector('.rp-section-header');
  if (rpFirstHdr) rpFirstHdr.appendChild(rpColBtn);

  rpColBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    _saved.rpWidth = rpEl.getBoundingClientRect().width;
    rpEl.classList.add('rp-outer-collapsed');
    setVar('--right-panel-width', 32);
  });
  rpExpandStrip.addEventListener('click', () => {
    rpEl.classList.remove('rp-outer-collapsed');
    setVar('--right-panel-width', _saved.rpWidth);
  });

  // ── Asset panel top-edge resize + collapse ────────────────
  apEl.style.position = 'relative';
  const apHandle = _addHandle(apEl, 'ns-top');
  _wireNS(apHandle, -1,
    () => apEl.getBoundingClientRect().height,
    (h) => setVar('--asset-panel-height', Math.max(80, Math.min(500, h))),
    () => apEl.classList.remove('ap-outer-collapsed'),
  );

  const apColBtn = _makeBtn(icon('ChevronDown', { width: 13, height: 13 }), 'Collapse assets', 'panel-collapse-btn');
  const apExpandStrip = document.createElement('div');
  apExpandStrip.className = 'ap-expand-strip';
  apExpandStrip.innerHTML = icon('ChevronUp', { width: 14, height: 14 });
  apExpandStrip.title = 'Expand assets';
  apEl.appendChild(apExpandStrip);

  const apTreeHdr = apEl.querySelector('.ap-tree-header');
  if (apTreeHdr) apTreeHdr.appendChild(apColBtn);

  apColBtn.addEventListener('click', () => {
    _saved.apHeight = apEl.getBoundingClientRect().height;
    apEl.classList.add('ap-outer-collapsed');
    setVar('--asset-panel-height', 32);
  });
  apExpandStrip.addEventListener('click', () => {
    apEl.classList.remove('ap-outer-collapsed');
    setVar('--asset-panel-height', _saved.apHeight);
  });
}

function _addHandle(parent, type) {
  const el = document.createElement('div');
  el.className = `panel-resize panel-resize-${type}`;
  parent.appendChild(el);
  return el;
}

function _makeBtn(innerHTML, title, cls) {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.innerHTML = innerHTML;
  btn.title = title;
  btn.type = 'button';
  return btn;
}

function _wireEW(handle, dir, getCur, apply, onStart) {
  let startX = 0, startW = 0;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = getCur();
    if (onStart) onStart();
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ew-resize';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    apply(startW + (e.clientX - startX) * dir);
  });
  const end = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    try { handle.releasePointerCapture(e.pointerId); } catch { /**/ }
    document.body.style.cursor = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

function _wireNS(handle, dir, getCur, apply, onStart) {
  let startY = 0, startH = 0;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startY = e.clientY;
    startH = getCur();
    if (onStart) onStart();
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ns-resize';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    apply(startH + (e.clientY - startY) * dir);
  });
  const end = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    try { handle.releasePointerCapture(e.pointerId); } catch { /**/ }
    document.body.style.cursor = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

bootstrap().catch(err => {
  console.error('Bootstrap failed:', err);
  document.getElementById('viewport')?.insertAdjacentHTML('beforeend', `
    <div style="
      position:absolute;inset:0;display:flex;align-items:center;justify-content:center;
      background:rgba(10,10,11,.9);color:#ef4444;font-family:system-ui;font-size:.9rem;
    ">Failed to initialise: ${err.message}</div>
  `);
});
