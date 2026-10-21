// Interface style: 'new' (mixo-app-style, dense) or 'original' (washi). Lives
// as data-ui-style on <html>; src/styles/style-new.css scopes every New rule
// under :root:not([data-ui-style="original"]).

import { dispatch } from './StateManager.js';
import { EVENTS } from './events.js';
import { STORAGE_KEY, STORAGE_VERSION, normaliseStyle, readStyle, applyStyle } from './uiStyleStore.js';

export { UI_STYLES, STORAGE_KEY, readStyle, applyStyle } from './uiStyleStore.js';

export function getStyle() {
  return normaliseStyle(globalThis.document?.documentElement?.dataset.uiStyle ?? readStyle());
}

/** Persist, apply and announce a style change. No-op when unchanged. */
export function setStyle(style) {
  const next = normaliseStyle(style);
  if (next === getStyle()) return;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify({ v: STORAGE_VERSION, style: next })); }
  catch { /* private mode / quota — non-fatal */ }
  applyStyle(next);
  dispatch(EVENTS.UI_STYLE_CHANGED, { style: next });
}
