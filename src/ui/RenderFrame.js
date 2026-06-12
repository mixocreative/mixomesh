// Render-frame overlay — while "Render view" is active (Scene ▸ Rendering) a
// rectangle matching the output aspect sits centred in the viewport and the
// huge box-shadow darkens everything outside it, so the user composes against
// exactly what capturePng will produce. Pointer-events pass through — the
// camera stays fully navigable underneath.

import { fitFrameRect } from '../core/render/RenderMath.js';

let _el = null;          // overlay div, lazily created inside #viewport
let _label = null;
let _aspect = { w: 1920, h: 1080 };
let _active = false;
let _ro = null;

/** Show the frame for the given output resolution (also live-updates it). */
export function show({ width, height } = {}) {
  if (Number.isFinite(width))  _aspect.w = width;
  if (Number.isFinite(height)) _aspect.h = height;
  const viewport = document.getElementById('viewport');
  if (!viewport) return;
  if (!_el) {
    _el = document.createElement('div');
    _el.className = 'render-frame';
    _el.setAttribute('aria-hidden', 'true');
    _label = document.createElement('span');
    _label.className = 'render-frame-label';
    _el.appendChild(_label);
    const cross = document.createElement('span');
    cross.className = 'render-frame-cross';
    _el.appendChild(cross);
    viewport.appendChild(_el);
    if (typeof ResizeObserver === 'function') {
      _ro = new ResizeObserver(() => { if (_active) _layout(); });
      _ro.observe(viewport);
    }
  }
  _active = true;
  _el.style.display = 'block';
  _layout();
}

export function hide() {
  _active = false;
  if (_el) _el.style.display = 'none';
}

/** @returns {boolean} */
export function isActive() { return _active; }

function _layout() {
  const viewport = document.getElementById('viewport');
  if (!viewport || !_el) return;
  const r = fitFrameRect(viewport.clientWidth, viewport.clientHeight, _aspect.w, _aspect.h);
  _el.style.left   = `${r.left}px`;
  _el.style.top    = `${r.top}px`;
  _el.style.width  = `${r.width}px`;
  _el.style.height = `${r.height}px`;
  if (_label) _label.textContent = `${Math.round(_aspect.w)} × ${Math.round(_aspect.h)}`;
}

export const RenderFrame = { show, hide, isActive };
