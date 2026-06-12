import { icon } from '../core/Icons.js';

const MIN_SECTION_PX = 80;
const _saved = { olWidth: 260, rpWidth: 300, apHeight: 220 };

/** Wire static shell affordances that are outside individual panels. */
export function init() {
  _wireRightPanelSections();
  _wireOuterPanels();
  clearBootStatus();
}

export function clearBootStatus() {
  document.getElementById('boot-status')?.remove();
}

function _wireRightPanelSections() {
  document.querySelectorAll('#right-panel .rp-section-header').forEach(btn => {
    const sync = () => {
      const sec = btn.closest('.rp-section');
      btn.setAttribute('aria-expanded', String(!sec?.classList.contains('collapsed')));
    };
    btn.addEventListener('click', () => {
      const sec = btn.closest('.rp-section');
      sec?.classList.toggle('collapsed');
      sync();
    });
    sync();
  });

  const splitter = document.querySelector('[data-rp-splitter]');
  const top      = document.getElementById('rp-properties');
  const panel    = document.getElementById('right-panel');
  if (!splitter || !top || !panel) return;

  let dragging = false;
  let startY = 0;
  let initialTopH = 0;
  let panelH = 0;

  const metrics = () => {
    const h = panel.getBoundingClientRect().height;
    const splitterH = splitter.getBoundingClientRect().height;
    return {
      current: top.getBoundingClientRect().height,
      maxTop: Math.max(MIN_SECTION_PX, h - MIN_SECTION_PX - splitterH),
    };
  };

  const setTopHeight = (height) => {
    const { maxTop } = metrics();
    const next = Math.max(MIN_SECTION_PX, Math.min(maxTop, height));
    top.style.flex = `0 0 ${next}px`;
    splitter.setAttribute('aria-valuemin', String(MIN_SECTION_PX));
    splitter.setAttribute('aria-valuemax', String(Math.round(maxTop)));
    splitter.setAttribute('aria-valuenow', String(Math.round(next)));
  };

  splitter.addEventListener('pointerdown', (e) => {
    if (top.classList.contains('collapsed')) return;
    dragging = true;
    startY = e.clientY;
    initialTopH = top.getBoundingClientRect().height;
    panelH = panel.getBoundingClientRect().height;
    try { splitter.setPointerCapture(e.pointerId); } catch { /* pointer capture optional */ }
    splitter.classList.add('dragging');
    document.body.style.cursor = 'row-resize';
    e.preventDefault();
  });

  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const maxTop = panelH - MIN_SECTION_PX - splitter.getBoundingClientRect().height;
    const next = Math.max(MIN_SECTION_PX, Math.min(maxTop, initialTopH + e.clientY - startY));
    top.style.flex = `0 0 ${next}px`;
    splitter.setAttribute('aria-valuenow', String(Math.round(next)));
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = false;
    try { splitter.releasePointerCapture(e.pointerId); } catch { /* pointer capture optional */ }
    splitter.classList.remove('dragging');
    document.body.style.cursor = '';
  };
  splitter.addEventListener('pointerup',     endDrag);
  splitter.addEventListener('pointercancel', endDrag);

  splitter.addEventListener('keydown', (e) => {
    const { current, maxTop } = metrics();
    if (e.key === 'ArrowUp') {
      setTopHeight(current - 16);
    } else if (e.key === 'ArrowDown') {
      setTopHeight(current + 16);
    } else if (e.key === 'Home') {
      setTopHeight(MIN_SECTION_PX);
    } else if (e.key === 'End') {
      setTopHeight(maxTop);
    } else {
      return;
    }
    e.preventDefault();
  });
  // Init aria ONLY — no flex pin. AppShell runs before Workspace applies the
  // per-workspace section CSS, so pinning here freezes a transient boot
  // layout (Properties ended up ~80px tall everywhere). The pin happens on
  // the first actual drag / keyboard resize.
  {
    const { current, maxTop } = metrics();
    splitter.setAttribute('aria-valuemin', String(MIN_SECTION_PX));
    splitter.setAttribute('aria-valuemax', String(Math.round(maxTop)));
    splitter.setAttribute('aria-valuenow', String(Math.round(current)));
  }
}

function _wireOuterPanels() {
  const app = document.getElementById('app');
  const olEl = document.getElementById('outliner');
  const rpEl = document.getElementById('right-panel');
  const apEl = document.getElementById('asset-panel');
  if (!app || !olEl || !rpEl || !apEl) return;

  const setVar = (name, val) => app.style.setProperty(name, `${val}px`);

  olEl.style.position = 'relative';
  _wireEW(_addHandle(olEl, 'ew-right'), +1,
    () => olEl.getBoundingClientRect().width,
    (w) => setVar('--outliner-width', Math.max(140, Math.min(600, w))),
    () => olEl.classList.remove('ol-outer-collapsed'),
  );

  const olColBtn = _makeBtn(icon('ChevronLeft', { width: 13, height: 13 }), 'Collapse outliner', 'panel-collapse-btn');
  const olExpandStrip = _makeBtn(icon('ChevronRight', { width: 14, height: 14 }), 'Expand outliner', 'ol-expand-strip');
  olEl.appendChild(olExpandStrip);
  olEl.querySelector('.ol-header')?.appendChild(olColBtn);

  olColBtn.addEventListener('click', () => {
    _saved.olWidth = olEl.getBoundingClientRect().width;
    olEl.classList.add('ol-outer-collapsed');
    setVar('--outliner-width', 32);
  });
  olExpandStrip.addEventListener('click', () => {
    olEl.classList.remove('ol-outer-collapsed');
    setVar('--outliner-width', _saved.olWidth);
  });

  rpEl.style.position = 'relative';
  _wireEW(_addHandle(rpEl, 'ew-left'), -1,
    () => rpEl.getBoundingClientRect().width,
    (w) => setVar('--right-panel-width', Math.max(200, Math.min(600, w))),
    () => rpEl.classList.remove('rp-outer-collapsed'),
  );

  const rpColBtn = _makeBtn(icon('ChevronRight', { width: 13, height: 13 }), 'Collapse inspector', 'panel-collapse-btn rp-panel-collapse');
  const rpExpandStrip = _makeBtn(icon('ChevronLeft', { width: 14, height: 14 }), 'Expand inspector', 'rp-expand-strip');
  rpEl.append(rpColBtn, rpExpandStrip);

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

  apEl.style.position = 'relative';
  _wireNS(_addHandle(apEl, 'ns-top'), -1,
    () => apEl.getBoundingClientRect().height,
    (h) => setVar('--asset-panel-height', Math.max(80, Math.min(500, h))),
    () => apEl.classList.remove('ap-outer-collapsed'),
  );

  const apColBtn = _makeBtn(icon('ChevronDown', { width: 13, height: 13 }), 'Collapse assets', 'panel-collapse-btn');
  const apExpandStrip = _makeBtn(icon('ChevronUp', { width: 14, height: 14 }), 'Expand assets', 'ap-expand-strip');
  apEl.appendChild(apExpandStrip);
  apEl.querySelector('.ap-tree-header')?.appendChild(apColBtn);

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

function _makeBtn(innerHTML, label, cls) {
  const btn = document.createElement('button');
  btn.className = cls;
  btn.innerHTML = innerHTML;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.type = 'button';
  return btn;
}

function _wireEW(handle, dir, getCur, apply, onStart) {
  let startX = 0, startW = 0;
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startW = getCur();
    onStart?.();
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ew-resize';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    apply(startW + (e.clientX - startX) * dir);
  });
  const end = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* pointer capture optional */ }
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
    onStart?.();
    handle.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'ns-resize';
  });
  handle.addEventListener('pointermove', (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    apply(startH + (e.clientY - startY) * dir);
  });
  const end = (e) => {
    if (!handle.hasPointerCapture(e.pointerId)) return;
    try { handle.releasePointerCapture(e.pointerId); } catch { /* pointer capture optional */ }
    document.body.style.cursor = '';
  };
  handle.addEventListener('pointerup', end);
  handle.addEventListener('pointercancel', end);
}

export const AppShell = { init, clearBootStatus };
