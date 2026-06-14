import en from './locales/en.json' with { type: 'json' };
import ja from './locales/ja.json' with { type: 'json' };
import zhHant from './locales/zh-Hant.json' with { type: 'json' };
import { interpolate } from './interpolate.js';
import { parsePlural } from './plural.js';
import { detectFromNavigator } from './detect.js';
import { dispatch } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';

export const SUPPORTED = ['en', 'ja', 'zh-Hant'];
const STORAGE_KEY = 'mx-locale-v1';
const VERSION = 1;
const TABLES = { en, ja, 'zh-Hant': zhHant };

let _locale = 'en';

/** Current resolved locale code. */
export function getLocale() { return _locale; }

/**
 * Translate `key` with optional `{var}` interpolation. Falls back through
 * the active locale → en → key string. Plural templates (keys starting with
 * `_plural.` or any value matching the ICU shape) are routed through plural.js
 * when `params.n` is a finite number.
 */
export function t(key, params) {
  const raw = TABLES[_locale]?.[key] ?? TABLES.en[key];
  if (raw == null) {
    if (typeof location !== 'undefined' &&
        (location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
      console.warn(`[i18n] missing key: ${key}`);
    }
    return key;
  }
  if (params && Number.isFinite(params.n) && raw.startsWith('{')) {
    const plural = parsePlural(raw, params.n, _locale);
    if (plural != null) return interpolate(plural, params);
  }
  return interpolate(raw, params);
}

/**
 * Set the active locale, persist to localStorage, flip <html lang>, fire
 * LOCALE_CHANGED. Unknown codes silently fall back to 'en'.
 */
export function setLocale(code) {
  const next = SUPPORTED.includes(code) ? code : 'en';
  if (next === _locale) return;
  _locale = next;
  _persist(next);
  applyHtmlLang();
  dispatch(EVENTS.LOCALE_CHANGED, { locale: next });
}

/** Write <html lang="..."> to match the active locale. */
export function applyHtmlLang() {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('lang', _locale);
  }
}

/**
 * Detection precedence: URL ?locale= → localStorage → navigator.languages → 'en'.
 * Returns the chosen code WITHOUT persisting (so a ?locale=xx URL override
 * doesn't poison the stored preference).
 */
export function detectLocale() {
  if (typeof location !== 'undefined') {
    const params = new URLSearchParams(location.search);
    const url = params.get('locale');
    if (url && SUPPORTED.includes(url)) return url;
  }
  const stored = _readStored();
  if (stored && SUPPORTED.includes(stored)) return stored;
  if (typeof navigator !== 'undefined') {
    const fromNav = detectFromNavigator(navigator.languages ?? [navigator.language], SUPPORTED);
    if (fromNav) return fromNav;
  }
  return 'en';
}

/**
 * Boot entry point. Detects, applies html lang, sets `_locale`, fires
 * LOCALE_CHANGED once for panels that mount after boot.
 */
export function init() {
  _locale = detectLocale();
  applyHtmlLang();
  dispatch(EVENTS.LOCALE_CHANGED, { locale: _locale });
}

function _persist(code) {
  if (typeof localStorage === 'undefined') return;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: VERSION, locale: code })); }
  catch { /* private mode / quota — non-fatal */ }
}

function _readStored() {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj?.locale ?? null;
  } catch { return null; }
}
