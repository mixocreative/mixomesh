'use strict';
// V8 heap for the desktop renderer (heavy-mesh spec §4). Typed arrays (mesh
// data) live off-heap, but parse/import bookkeeping, ASCII text and JS arrays
// do not; Chromium's default old-space limit is lower than what a 10M-triangle
// session needs at peak. 4 GiB is the ceiling under V8 pointer compression
// (Electron's default), so asking for more would be ignored.

const RENDERER_HEAP_MB = 4096;
const JS_FLAGS = `--max-old-space-size=${RENDERER_HEAP_MB}`;

/** Append the js-flags switch once, before app ready. Keeps any flags already given. */
function applyHeapFlags(app) {
  const line = app?.commandLine;
  if (!line?.appendSwitch) return null;
  const existing = line.getSwitchValue?.('js-flags') || '';
  if (/--max-old-space-size=/.test(existing)) return existing;
  const value = existing ? `${existing} ${JS_FLAGS}` : JS_FLAGS;
  line.appendSwitch('js-flags', value);
  return value;
}

module.exports = { applyHeapFlags, RENDERER_HEAP_MB, JS_FLAGS };
