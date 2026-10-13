// Touch gesture recogniser (overhaul 8.4, Blueprint PART 6 "Touch").
//
// Pure: pointer records in → gesture records out. No DOM, no Babylon, no
// timers — the caller feeds `down/move/up/cancel` with `{ id, x, y, t }` and
// arms its own timer that calls `poll(t)` for the long-press. That keeps the
// whole state machine unit-testable in Node (tests/touch-gestures.test.mjs).
// Only pointerType 'touch' is ever fed in; mouse/pen never reach this module.
//
// Gestures emitted (coordinates are whatever space the caller fed — client px):
//   { type:'press', x, y }                         first finger down (caller may stage a body drag)
//   { type:'orbit', phase:'start', dx, dy, x, y, startX, startY }
//   { type:'orbit', phase:'move',  dx, dy, x, y }  one-finger drag past TOUCH_SLOP_PX
//   { type:'orbit', phase:'end', x, y, interrupted?, cancelled? }
//   { type:'pan',   dx, dy, x, y }                 two-finger centroid moved
//   { type:'pinch', scale, x, y }                  two-finger spread changed (scale = cur/prev distance; x,y = centre)
//   { type:'tap',       x, y }
//   { type:'doubletap', x, y }                     second tap < TOUCH_DOUBLE_TAP_MS / < TOUCH_DOUBLE_TAP_PX after a tap
//   { type:'longpress', x, y }                     held ≥ TOUCH_LONG_PRESS_MS moving < TOUCH_SLOP_PX
// The one-finger drag is called 'orbit' because that is its meaning on empty
// space; the consumer reinterprets it as a body drag when the press began on a
// selected, movable item (InputManager).

export const TOUCH_SLOP_PX        = 8;     // movement below this keeps tap / long-press alive
export const TOUCH_DOUBLE_TAP_MS  = 350;   // same window as the mouse double-click
export const TOUCH_DOUBLE_TAP_PX  = 12;    // fingers land less precisely than a mouse (4 px)
export const TOUCH_LONG_PRESS_MS  = 500;

/**
 * Create one recogniser (one per viewport).
 * @param {{ now?: () => number }} [opts]
 */
export function createTouchGestures({ now = () => performance.now() } = {}) {
  /** @type {Map<number, {x:number, y:number}>} at most two tracked fingers */
  const ptrs = new Map();
  let mode = 'idle';        // 'idle' | 'pending' | 'drag' | 'multi' | 'done'
  let start = null;         // { x, y, t } of the single-finger press
  let last = null;          // last single-finger position
  let prevDist = 0;
  let prevC = null;         // previous two-finger centroid
  let lastTap = null;       // { x, y, t } of the previous plain tap (press time)

  const time = (e) => (Number.isFinite(e?.t) ? e.t : now());

  function two() {
    const [a, b] = [...ptrs.values()];
    return {
      c: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      d: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }
  function initMulti() {
    const { c, d } = two();
    prevC = c;
    prevDist = d;
  }

  function down(e) {
    if (ptrs.has(e.id) || ptrs.size >= 2) return [];   // a third finger is ignored
    ptrs.set(e.id, { x: e.x, y: e.y });
    if (ptrs.size === 1) {
      if (mode !== 'idle') return [];
      mode = 'pending';
      start = { x: e.x, y: e.y, t: time(e) };
      last = { x: e.x, y: e.y };
      return [{ type: 'press', x: e.x, y: e.y }];
    }
    // Second finger: two-finger navigation from here until every finger lifts.
    const out = [];
    if (mode === 'drag') out.push({ type: 'orbit', phase: 'end', x: last.x, y: last.y, interrupted: true });
    if (mode === 'pending' || mode === 'drag' || mode === 'multi') {
      mode = 'multi';
      lastTap = null;
      initMulti();
    }
    return out;
  }

  function move(e) {
    const p = ptrs.get(e.id);
    if (!p) return [];
    p.x = e.x; p.y = e.y;
    if (mode === 'pending') {
      if (Math.hypot(e.x - start.x, e.y - start.y) < TOUCH_SLOP_PX) { last = { x: e.x, y: e.y }; return []; }
      mode = 'drag';
      last = { x: e.x, y: e.y };
      return [{ type: 'orbit', phase: 'start', dx: e.x - start.x, dy: e.y - start.y, x: e.x, y: e.y, startX: start.x, startY: start.y }];
    }
    if (mode === 'drag') {
      const dx = e.x - last.x, dy = e.y - last.y;
      last = { x: e.x, y: e.y };
      if (!dx && !dy) return [];
      return [{ type: 'orbit', phase: 'move', dx, dy, x: e.x, y: e.y }];
    }
    if (mode === 'multi' && ptrs.size === 2) {
      const { c, d } = two();
      const out = [];
      const dx = c.x - prevC.x, dy = c.y - prevC.y;
      if (dx || dy) out.push({ type: 'pan', dx, dy, x: c.x, y: c.y });
      if (prevDist > 0 && d > 0 && d !== prevDist) out.push({ type: 'pinch', scale: d / prevDist, x: c.x, y: c.y });
      prevC = c;
      if (d > 0) prevDist = d;
      return out;
    }
    return [];
  }

  function up(e) {
    if (!ptrs.has(e.id)) return [];
    const p = ptrs.get(e.id);
    ptrs.delete(e.id);
    const out = [];
    if (mode === 'pending') {
      const t = time(e);
      if (t - start.t >= TOUCH_LONG_PRESS_MS) {
        // The poll timer did not get there first — still a long-press, never a tap.
        lastTap = null;
        out.push({ type: 'longpress', x: p.x, y: p.y });
      } else if (lastTap && start.t - lastTap.t < TOUCH_DOUBLE_TAP_MS
                 && Math.hypot(start.x - lastTap.x, start.y - lastTap.y) < TOUCH_DOUBLE_TAP_PX) {
        lastTap = null;
        out.push({ type: 'doubletap', x: start.x, y: start.y });
      } else {
        lastTap = { x: start.x, y: start.y, t: start.t };
        out.push({ type: 'tap', x: start.x, y: start.y });
      }
    } else if (mode === 'drag') {
      lastTap = null;
      out.push({ type: 'orbit', phase: 'end', x: p.x, y: p.y });
    }
    if (ptrs.size === 0) { mode = 'idle'; start = null; }
    return out;
  }

  /** Abort one finger (pointercancel) or, with no id, the whole gesture. */
  function cancel(id) {
    if (id != null && !ptrs.has(id)) return [];
    const out = [];
    if (mode === 'drag') out.push({ type: 'orbit', phase: 'end', x: last.x, y: last.y, cancelled: true });
    if (id == null) ptrs.clear(); else ptrs.delete(id);
    lastTap = null;
    mode = ptrs.size ? 'done' : 'idle';
    if (!ptrs.size) start = null;
    return out;
  }

  /** Long-press check — call from a timer armed on 'press'. */
  function poll(t = now()) {
    if (mode !== 'pending' || ptrs.size !== 1 || t - start.t < TOUCH_LONG_PRESS_MS) return [];
    mode = 'done';
    lastTap = null;
    return [{ type: 'longpress', x: last.x, y: last.y }];
  }

  return {
    down, move, up, cancel, poll,
    /** @returns {string} current mode (tests / debugging) */
    mode: () => mode,
    /** @returns {number} tracked finger count */
    count: () => ptrs.size,
  };
}

/**
 * Pinch-zoom about a fixed world point. Scaling both the radius and the
 * target's offset from `point` by the same factor is a homothety centred on
 * `point`, so the point stays under the pinch centre in perspective AND
 * orthographic (ortho extents follow the radius). Pure — plain {x,y,z}.
 * @param {{x:number,y:number,z:number}} target  current camera target
 * @param {{x:number,y:number,z:number}|null} point  world point under the pinch centre (null → zoom about target)
 * @param {number} radius  current camera radius
 * @param {number} scale   finger-distance ratio (> 1 = spread = zoom in)
 * @param {number} [lo]    lower radius limit
 * @param {number} [hi]    upper radius limit
 * @returns {{ radius:number, target:{x:number,y:number,z:number}, moved:boolean }|null} null = no change
 */
export function zoomAboutPoint(target, point, radius, scale, lo = 0, hi = Infinity) {
  if (!(scale > 0) || !Number.isFinite(scale) || !(radius > 0)) return null;
  const r1 = Math.min(hi ?? Infinity, Math.max(lo ?? 0, radius / scale));
  if (r1 === radius) return null;
  const k = r1 / radius;
  if (!point) return { radius: r1, target: { x: target.x, y: target.y, z: target.z }, moved: false };
  return {
    radius: r1,
    target: {
      x: point.x + (target.x - point.x) * k,
      y: point.y + (target.y - point.y) * k,
      z: point.z + (target.z - point.z) * k,
    },
    moved: true,
  };
}

export const TouchGestures = { createTouchGestures, zoomAboutPoint };
