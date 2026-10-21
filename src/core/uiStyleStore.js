// Interface style storage, dependency-free so the <head> boot module
// (src/app/ui-style-boot.js) can load it before the app. 'new' is the
// default: style-new.css applies whenever data-ui-style is not 'original',
// so a missing attribute already renders New.

export const UI_STYLES = ['new', 'original'];
export const STORAGE_KEY = 'mx-ui-style-v1';
export const STORAGE_VERSION = 1;

export function normaliseStyle(style) {
  return UI_STYLES.includes(style) ? style : UI_STYLES[0];
}

/** Stored style, or 'new' when missing, unreadable or unknown. */
export function readStyle(storage = globalThis.localStorage) {
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    return normaliseStyle(raw ? JSON.parse(raw)?.style : null);
  } catch { return UI_STYLES[0]; }
}

export function applyStyle(style, root = globalThis.document?.documentElement) {
  if (root) root.dataset.uiStyle = normaliseStyle(style);
}
