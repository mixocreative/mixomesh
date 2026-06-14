# Wafu Playful UI + i18n Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Blender-dark UI with a washi-light *wafu* (Japanese-style) theme, add a koi mascot + hanko toast + optional snap sound, add furigana on workspace tabs, and introduce a real i18n system (EN / JA / zh-Hant) with browser detection, user override, and `localStorage` persistence.

**Architecture:** Three independently revertable PRs behind git tags. PR1 ships i18n with zero visual change (pure code). PR2 swaps the design tokens, renames `blender.css` → `wafu.css` carrying every selector forward, and retunes the viewport light rig for a light background. PR3 appends texture / koi / hanko / sound / furigana layers on top of the visual base and adds the `ui` settings slice.

**Tech Stack:** Vanilla JS modules, Vite 8, Babylon.js 9.6.2, CSS custom properties, JSON imports via `with { type: 'json' }`, `Intl.PluralRules`, WebAudio, Node `node:test` runner.

**Safety anchor:** Tag `pre-wafu-2026-06-14` already points at `03585b2` on `master`. Rollback the entire initiative with `git reset --hard pre-wafu-2026-06-14`.

**Spec:** `docs/superpowers/specs/2026-06-14-wafu-playful-ui-i18n-design.md`
**Translator guide:** `docs/TRANSLATIONS.md` (already shipped in spec commit)

---

## File Structure

### New files

```
src/i18n/
  index.js                       // t(), setLocale(), getLocale(), detectLocale(), init(), applyHtmlLang(), SUPPORTED
  plural.js                      // ICU-lite {n, plural, ...} mini-parser
  interpolate.js                 // {var} interpolation
  detect.js                      // BCP-47 → SUPPORTED mapping
  locales/en.json
  locales/ja.json
  locales/zh-Hant.json

src/ui/
  LocaleSwitcher.js              // header <select>
  Mascot.js                      // koi mount/unmount + idle/swim/splash
  Hanko.js                       // stamp-drop toast wrapper (PR3)
  Sound.js                       // WebAudio lazy init, plays on snap

src/styles/
  wafu.css                       // PR2: renamed from blender.css; PR3: APPENDED with texture/koi/hanko layers

public/
  textures/washi.svg
  textures/asanoha.svg
  textures/seigaiha.svg
  koi.svg
  sounds/tok.mp3
  fonts/YujiSyuku-Regular.woff2  // self-hosted CSP fallback

scripts/
  i18n-check.mjs                 // CI validator

tests/
  i18n.test.mjs                  // pure-logic tests (PR1)
  i18n-detect.test.mjs           // detection precedence (PR1)
  i18n-plural.test.mjs           // plural parsing (PR1)
  ui-slice.test.mjs              // ui settings slice (PR3)
```

### Modified files

```
src/app/boot.ts                  // PR1: call i18n.init() first; PR3: Mascot/Hanko/Sound init
src/app/main.ts                  // PR3: optional render wiring (Mascot/Hanko mount)
src/core/events.js               // PR1: add LOCALE_CHANGED; PR3: add CURSOR_SNAP (if not already on CURSOR_CHANGED)
src/core/StateManager.js         // PR3: add ui slice w/ mascotEnabled+soundEnabled
src/core/SettingsStore.js        // PR3: add 'ui' to SCHEMA + SECTIONS.appearance reset target
src/config/default-settings.json // PR2: light-rig retune; PR3: add "ui" block
src/core/scene/SceneConstants.js // PR2: viewport gradient + selection outline colors
src/ui/Toast.js                  // PR3: delegate visuals to Hanko, keep API
src/styles/tokens.css            // PR2: full rewrite (washi palette + Yuji)
src/styles/blender.css           // PR2: RENAMED to wafu.css (no content change here)
index.html                       // PR1: <html lang> stays "en" (script flips on boot); PR2: <link> blender.css→wafu.css; PR2: Yuji font preload
package.json                     // PR1: add "i18n:check" script
src/ui/AppShell.js               // PR1: inject LocaleSwitcher into header
src/ui/Properties.js + panels    // PR1: mark all visible strings with t() + data-i18n-key (sweep)
```

---

## PR1 — i18n (zero visual change)

**Branch:** `feat/i18n`
**Tag on merge:** `i18n-shipped`

### Task 1.1: Scaffold i18n module + locale JSON files

**Files:**
- Create: `src/i18n/locales/en.json`
- Create: `src/i18n/locales/ja.json`
- Create: `src/i18n/locales/zh-Hant.json`
- Create: `src/i18n/interpolate.js`
- Create: `src/i18n/plural.js`
- Create: `src/i18n/detect.js`
- Create: `src/i18n/index.js`

- [ ] **Step 1: Create `src/i18n/locales/en.json` with the v1 seed strings from spec Appendix A**

Use every row of Appendix A. Example slice:

```json
{
  "app.brand": "Mixomesh",
  "locale.en": "English",
  "locale.ja": "日本語",
  "locale.zh-Hant": "繁體中文",
  "workspace.layout": "Layout",
  "workspace.layout.sub": "配置",
  "workspace.shade": "Shade",
  "workspace.shade.sub": "彩",
  "workspace.scene": "Scene",
  "workspace.scene.sub": "場",
  "workspace.print": "Print",
  "workspace.print.sub": "刷",
  "panel.properties.title": "Properties",
  "panel.scene.title": "Scene",
  "panel.print.title": "Print",
  "panel.shader.title": "Shader",
  "panel.outliner.title": "Outliner",
  "panel.assets.title": "Assets",
  "panel.session.title": "Session",
  "panel.library.title": "Library",
  "section.transform": "Transform",
  "section.shader": "Shader",
  "section.uv": "UV",
  "section.environment": "Environment",
  "section.camera": "Camera",
  "section.grid": "Grid",
  "section.rendering": "Rendering",
  "section.cross-section": "Cross Section",
  "section.appearance": "Appearance",
  "btn.reset": "Reset",
  "btn.apply": "Apply",
  "btn.cancel": "Cancel",
  "btn.ok": "OK",
  "btn.import": "Import",
  "btn.export": "Export",
  "btn.new": "New",
  "btn.save": "Save",
  "btn.open": "Open",
  "btn.close": "Close",
  "setting.locale": "Language",
  "setting.mascot": "Mascot",
  "setting.sound": "Sound",
  "toast.exported": "Exported {filename}",
  "toast.saved": "Saved",
  "toast.reset": "Reset to defaults",
  "import.error.title": "Couldn't import {filename}",
  "empty.viewport": "Drop a file or import to start",
  "empty.session": "No assets in this session",
  "hanko.done": "done",
  "hanko.failed": "failed",
  "hanko.saved": "saved",
  "_plural.objects": "{n, plural, =0{No objects} one{1 object} other{# objects}}"
}
```

- [ ] **Step 2: Create `src/i18n/locales/ja.json`** with the JA column from spec Appendix A (use the exact strings — they were locked at brainstorm).

- [ ] **Step 3: Create `src/i18n/locales/zh-Hant.json`** with the zh-Hant column from spec Appendix A.

- [ ] **Step 4: Create `src/i18n/interpolate.js`**

```js
// Replaces {name} in `s` with String(params[name]). Missing → leaves "{name}" intact.
// `s` MUST be a plain string; placeholders are literal text, never evaluated.
export function interpolate(s, params) {
  if (!params) return s;
  return s.replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
```

- [ ] **Step 5: Create `src/i18n/plural.js`** — tiny ICU-lite parser

```js
// Parses one ICU-style "{n, plural, =0{...} one{...} other{# ...}}" string and
// returns the arm matching `n` under `locale`. `#` inside an arm is replaced
// with the number. Anything else returns `undefined` (caller falls back to key).
//
// Format reference: https://unicode-org.github.io/icu/userguide/format_parse/messages/
// We support only =N exact match, the keywords (zero/one/two/few/many/other),
// and the `#` token. No nested selects, no offset, no select-by-string.
export function parsePlural(template, n, locale) {
  const m = template.match(/^\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*,\s*plural\s*,\s*(.+)\}\s*$/s);
  if (!m) return undefined;
  const body = m[2];
  const arms = _splitArms(body);
  const exact = arms.get(`=${n}`);
  if (exact != null) return exact.replace(/#/g, String(n));
  const cat = new Intl.PluralRules(locale).select(n);   // 'one' | 'other' | ...
  const armText = arms.get(cat) ?? arms.get('other');
  return armText == null ? undefined : armText.replace(/#/g, String(n));
}

// Splits "=0{...} one{...} other{...}" into Map<keyword, body>. Respects nested braces.
function _splitArms(body) {
  const out = new Map();
  let i = 0;
  while (i < body.length) {
    while (i < body.length && /\s/.test(body[i])) i++;
    const kStart = i;
    while (i < body.length && body[i] !== '{') i++;
    const key = body.slice(kStart, i).trim();
    if (body[i] !== '{') break;
    let depth = 1, j = i + 1;
    while (j < body.length && depth > 0) {
      if (body[j] === '{') depth++;
      else if (body[j] === '}') depth--;
      if (depth > 0) j++;
    }
    out.set(key, body.slice(i + 1, j));
    i = j + 1;
  }
  return out;
}
```

- [ ] **Step 6: Create `src/i18n/detect.js`**

```js
// Maps a BCP-47 tag (e.g. 'zh-TW', 'ja-JP', 'en-GB') to one of SUPPORTED, or
// null if no rule matches. Order of rules matters: zh-Hant > zh.
//
// Reference: https://www.rfc-editor.org/rfc/bcp/bcp47.txt §2.2
const ZH_HANT_REGION = /^(TW|HK|MO)$/i;
const ZH_HANT_SCRIPT = /^Hant$/i;

export function mapTag(tag, supported) {
  if (!tag || typeof tag !== 'string') return null;
  const [langRaw, ...rest] = tag.split('-');
  const lang = langRaw.toLowerCase();
  if (lang === 'en' && supported.includes('en')) return 'en';
  if (lang === 'ja' && supported.includes('ja')) return 'ja';
  if (lang === 'zh') {
    for (const part of rest) {
      if (ZH_HANT_SCRIPT.test(part) || ZH_HANT_REGION.test(part)) {
        return supported.includes('zh-Hant') ? 'zh-Hant' : null;
      }
    }
    // bare 'zh' or zh-Hans/zh-CN — no rule yet (no zh-Hans locale shipped).
    return null;
  }
  return null;
}

// Walks navigator.languages in order; first match wins.
export function detectFromNavigator(langs, supported) {
  for (const tag of langs ?? []) {
    const hit = mapTag(tag, supported);
    if (hit) return hit;
  }
  return null;
}
```

- [ ] **Step 7: Create `src/i18n/index.js`**

```js
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
```

- [ ] **Step 8: Commit**

```bash
git checkout -b feat/i18n
git add src/i18n
git commit -m "feat(i18n): scaffold module + EN/JA/zh-Hant locale JSON"
```

---

### Task 1.2: Add LOCALE_CHANGED to EVENTS

**Files:**
- Modify: `src/core/events.js`

- [ ] **Step 1: Add the event constant**

Append a new line under the `// UI` block:

```js
  LOCALE_CHANGED:          'i18n:localeChanged',
```

- [ ] **Step 2: Commit**

```bash
git add src/core/events.js
git commit -m "feat(events): add LOCALE_CHANGED"
```

---

### Task 1.3: Unit tests for `interpolate` + `plural` + `detect`

**Files:**
- Create: `tests/i18n.test.mjs`
- Create: `tests/i18n-plural.test.mjs`
- Create: `tests/i18n-detect.test.mjs`

- [ ] **Step 1: Write `tests/i18n.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpolate } from '../src/i18n/interpolate.js';

test('interpolate replaces {var} with params value', () => {
  assert.equal(interpolate('Hello {name}', { name: 'Adrian' }), 'Hello Adrian');
});

test('interpolate leaves unknown placeholders intact', () => {
  assert.equal(interpolate('Hello {who}', { name: 'Adrian' }), 'Hello {who}');
});

test('interpolate coerces non-string values to String', () => {
  assert.equal(interpolate('Count: {n}', { n: 3 }), 'Count: 3');
});

test('interpolate is a no-op when params is undefined', () => {
  assert.equal(interpolate('plain', undefined), 'plain');
});

test('interpolate is XSS-safe: HTML inside the value is literal text', () => {
  // The interpolation itself returns a plain string; consumers MUST set
  // textContent (never innerHTML). This test pins that the substitution
  // does NOT decode/encode anything.
  assert.equal(interpolate('Hi {x}', { x: '<script>a</script>' }), 'Hi <script>a</script>');
});
```

- [ ] **Step 2: Write `tests/i18n-plural.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePlural } from '../src/i18n/plural.js';

const T_EN = '{n, plural, =0{No objects} one{1 object} other{# objects}}';
const T_JA = '{n, plural, =0{オブジェクトなし} other{オブジェクト # 件}}';

test('parsePlural picks =0 arm for n=0 (EN)', () => {
  assert.equal(parsePlural(T_EN, 0, 'en'), 'No objects');
});

test('parsePlural picks "one" arm for n=1 (EN)', () => {
  assert.equal(parsePlural(T_EN, 1, 'en'), '1 object');
});

test('parsePlural picks "other" arm + replaces # for n=5 (EN)', () => {
  assert.equal(parsePlural(T_EN, 5, 'en'), '5 objects');
});

test('parsePlural picks "other" arm for n=1 in JA (no plural distinction)', () => {
  assert.equal(parsePlural(T_JA, 1, 'ja'), 'オブジェクト 1 件');
});

test('parsePlural returns undefined for malformed templates', () => {
  assert.equal(parsePlural('not a plural', 1, 'en'), undefined);
});
```

- [ ] **Step 3: Write `tests/i18n-detect.test.mjs`**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mapTag, detectFromNavigator } from '../src/i18n/detect.js';

const SUP = ['en', 'ja', 'zh-Hant'];

test('mapTag: zh-TW → zh-Hant', () => {
  assert.equal(mapTag('zh-TW', SUP), 'zh-Hant');
});

test('mapTag: zh-HK → zh-Hant', () => {
  assert.equal(mapTag('zh-HK', SUP), 'zh-Hant');
});

test('mapTag: zh-Hant → zh-Hant', () => {
  assert.equal(mapTag('zh-Hant', SUP), 'zh-Hant');
});

test('mapTag: zh-CN → null (no zh-Hans shipped)', () => {
  assert.equal(mapTag('zh-CN', SUP), null);
});

test('mapTag: bare zh → null', () => {
  assert.equal(mapTag('zh', SUP), null);
});

test('mapTag: ja-JP → ja', () => {
  assert.equal(mapTag('ja-JP', SUP), 'ja');
});

test('mapTag: en-GB → en', () => {
  assert.equal(mapTag('en-GB', SUP), 'en');
});

test('mapTag: fr-FR → null (unsupported)', () => {
  assert.equal(mapTag('fr-FR', SUP), null);
});

test('detectFromNavigator: first matching tag wins', () => {
  assert.equal(detectFromNavigator(['fr-FR', 'zh-TW', 'ja-JP'], SUP), 'zh-Hant');
});

test('detectFromNavigator: no match → null', () => {
  assert.equal(detectFromNavigator(['fr-FR', 'de-DE'], SUP), null);
});
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- tests/i18n.test.mjs tests/i18n-plural.test.mjs tests/i18n-detect.test.mjs
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add tests/i18n.test.mjs tests/i18n-plural.test.mjs tests/i18n-detect.test.mjs
git commit -m "test(i18n): interpolate + plural + detect unit tests"
```

---

### Task 1.4: Wire `i18n.init()` into boot order

**Files:**
- Modify: `src/app/boot.ts` (or follow-up `src/app/main.ts` where state/scene init lives — pick whichever runs FIRST after window.BABYLON is set, BEFORE panels mount)

- [ ] **Step 1: Inspect `src/app/main.ts` to find the earliest panel-mount call**

```bash
sed -n '1,80p' src/app/main.ts
```

(or use Read to see the boot sequence and identify where `AppShell.init()` / panel renders happen)

- [ ] **Step 2: Add `i18n.init()` BEFORE the first panel mount**

Inside `main.ts`, near the top (after StateManager seed but before AppShell / panel render):

```js
import * as i18n from '../i18n/index.js';

// ...existing imports/setup...

i18n.init();    // detect locale, set _locale, apply <html lang>, fire LOCALE_CHANGED
// ...existing AppShell.init(), panel renders, etc.
```

- [ ] **Step 3: Smoke-run dev server, confirm `<html lang>` flips when running with `?locale=ja`**

```bash
npm run dev
```

Open `http://127.0.0.1:5173/?locale=ja`, in DevTools console run:
```js
document.documentElement.getAttribute('lang')
```
Expected: `"ja"`.

- [ ] **Step 4: Commit**

```bash
git add src/app/main.ts
git commit -m "feat(boot): init i18n before panels mount"
```

---

### Task 1.5: LocaleSwitcher in header

**Files:**
- Create: `src/ui/LocaleSwitcher.js`
- Modify: `src/ui/AppShell.js`
- Modify: `index.html` (add a placeholder `<span id="locale-switcher-host"></span>` inside `<header id="header">` next to `#dirty-indicator`)
- Modify: `src/styles/components/project.css` (or wherever header layout lives — small left-margin auto on the switcher so it sits at the right edge)

- [ ] **Step 1: Add a host span to the header in `index.html`**

Inside `<header id="header">`, after `<span id="dirty-indicator"></span>`:

```html
      <span id="locale-switcher-host"></span>
```

- [ ] **Step 2: Create `src/ui/LocaleSwitcher.js`**

```js
import { SUPPORTED, getLocale, setLocale } from '../i18n/index.js';
import { t } from '../i18n/index.js';

// Labels shown for each language are ALWAYS rendered in their own script —
// universal i18n best practice (a JA user must read 日本語 in their own letters,
// not "Japanese"). Pulled from translation files so any locale-specific
// override surfaces through the same channel.
function labelFor(code) { return t(`locale.${code}`); }

export function mount(host) {
  if (!host) return;
  host.innerHTML = '';
  const sel = document.createElement('select');
  sel.id = 'locale-switcher';
  sel.setAttribute('aria-label', t('setting.locale'));
  sel.dataset.i18nKey = 'setting.locale';   // tests + reseed on LOCALE_CHANGED
  for (const code of SUPPORTED) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = labelFor(code);
    opt.dataset.locale = code;
    if (code === getLocale()) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', () => setLocale(sel.value));
  host.appendChild(sel);
}

/** Re-render labels (called from LOCALE_CHANGED listener in AppShell). */
export function refresh(host) {
  if (!host) return;
  const sel = host.querySelector('#locale-switcher');
  if (!sel) return;
  sel.setAttribute('aria-label', t('setting.locale'));
  for (const opt of sel.querySelectorAll('option')) {
    opt.textContent = t(`locale.${opt.dataset.locale}`);
  }
  sel.value = getLocale();
}

export const LocaleSwitcher = { mount, refresh };
```

- [ ] **Step 3: Wire it into `AppShell.init()`**

In `src/ui/AppShell.js`, top of the file:

```js
import { LocaleSwitcher } from './LocaleSwitcher.js';
import { subscribe } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
```

Inside `init()`, after `_wireRightPanelSections()` and `_wireOuterPanels()`:

```js
  const host = document.getElementById('locale-switcher-host');
  LocaleSwitcher.mount(host);
  subscribe(EVENTS.LOCALE_CHANGED, () => LocaleSwitcher.refresh(host));
```

- [ ] **Step 4: Smoke-test in browser**

```bash
npm run dev
```

Open the app, find the switcher in the header. Switch JA → reload. Confirm storage:
```js
JSON.parse(localStorage.getItem('mx-locale-v1'))    // → { v: 1, locale: 'ja' }
```

- [ ] **Step 5: Commit**

```bash
git add src/ui/LocaleSwitcher.js src/ui/AppShell.js index.html
git commit -m "feat(i18n): header LocaleSwitcher (EN / 日本語 / 繁體中文)"
```

---

### Task 1.6: Sweep — mark visible UI strings with `t()` + `data-i18n-key`

**Files (sweep targets — apply same mechanic to each):**
- `src/ui/PropertiesPanel.js`
- `src/ui/ScenePanel.js`
- `src/ui/PrintPanel.js`
- `src/ui/ShaderPanel.js`
- `src/ui/Outliner.js`
- `src/ui/AssetPanel.js`
- `src/ui/WorkspaceTabs.js` (or wherever the four-tab strip lives)
- `index.html` (static section titles in `<button class="rp-section-header">…<span class="rp-title">Properties</span>…`)

> Existing panels build DOM via `element.textContent = 'Properties'` or `innerHTML` with static labels. Replace literals with `t('key')`, tag the carrier element with `data-i18n-key="key"`, and add a `LOCALE_CHANGED` re-render hook per panel.

- [ ] **Step 1: Establish the pattern in `index.html` for the four right-panel section headers**

For each header (Properties / Shader Library / Scene / Print) edit the `.rp-title` span:

```html
<span class="rp-title" data-i18n-key="panel.properties.title">Properties</span>
```

Match the keys in `en.json`:
- Properties → `panel.properties.title`
- Shader Library → `panel.shader.title` (note: Shader vs Shader Library — the visible label here is "Shader Library"; use `panel.shaderLibrary.title` and add it to all three locale JSON files; EN `"Shader Library"`, JA `"シェーダーライブラリ"`, zh-Hant `"著色器資料庫"`)
- Scene → `panel.scene.title`
- Print → `panel.print.title`

- [ ] **Step 2: Add `panel.shaderLibrary.title` to all three locale JSON files**

`en.json`:
```json
"panel.shaderLibrary.title": "Shader Library",
```
`ja.json`:
```json
"panel.shaderLibrary.title": "シェーダーライブラリ",
```
`zh-Hant.json`:
```json
"panel.shaderLibrary.title": "著色器資料庫",
```

- [ ] **Step 3: For each panel JS file, add a top-level helper + LOCALE_CHANGED hook**

Pattern for `src/ui/PropertiesPanel.js` (apply analogously to ScenePanel / PrintPanel / ShaderPanel / Outliner / AssetPanel):

```js
import { t, getLocale } from '../i18n/index.js';
import { subscribe } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';

// Walk every element under `root` that carries data-i18n-key and rewrite its
// textContent through t(). MUST use textContent — translations are plain text,
// never HTML (translator-safety rule from spec §Security).
function _retranslate(root) {
  if (!root) return;
  for (const el of root.querySelectorAll('[data-i18n-key]')) {
    const key = el.dataset.i18nKey;
    if (!key) continue;
    el.textContent = t(key);
  }
}

// Inside the existing panel render() function, after the DOM is built:
//   _retranslate(panelRoot);
// Inside init() (one-time):
//   subscribe(EVENTS.LOCALE_CHANGED, () => _retranslate(panelRoot));
```

- [ ] **Step 4: Walk each panel and replace literal labels**

For every visible string in the panel render path:

1. Add the literal label to `en.json` if not already there (and to `ja.json` / `zh-Hant.json` — if you don't speak the language, leave `""`; validator warns, fallback to EN at runtime).
2. Wrap the element with `data-i18n-key="..."` and set its initial `textContent = t(key)`.

Concrete example — `ScenePanel.js` likely has a literal like `"Environment"` as a sub-section header. Replace:

```js
header.textContent = 'Environment';
```
with:
```js
header.dataset.i18nKey = 'section.environment';
header.textContent = t('section.environment');
```

- [ ] **Step 5: Verify the dev build still renders correctly in EN (default)**

```bash
npm run dev
```

Reload at `?locale=en` and confirm every section header / button / tab reads the same as before (zero visual change is the PR1 gate). Then `?locale=ja` and confirm JA renders.

- [ ] **Step 6: Commit (one commit per panel sweep — keeps the diff reviewable)**

```bash
git add src/ui/PropertiesPanel.js src/i18n/locales/*.json
git commit -m "feat(i18n): mark PropertiesPanel strings with t() + data-i18n-key"

git add src/ui/ScenePanel.js src/i18n/locales/*.json
git commit -m "feat(i18n): mark ScenePanel strings with t() + data-i18n-key"

# Repeat for PrintPanel, ShaderPanel, Outliner, AssetPanel, WorkspaceTabs.
```

---

### Task 1.7: Workspace tab labels carry primary + furigana sub-label

> Furigana visual ships in PR3; PR1 just needs the two i18n keys per tab to be wired so the sub-label exists in the DOM and changes locale.

**Files:**
- Modify: `src/ui/WorkspaceTabs.js` (or whichever file builds the four workspace tabs)

- [ ] **Step 1: Each tab carries TWO spans — primary label + sub-label**

Pattern in tab build code:

```js
function _buildTab(workspaceId) {
  const btn = document.createElement('button');
  btn.className = 'ws-tab';
  btn.dataset.workspace = workspaceId;

  const primary = document.createElement('span');
  primary.className = 'ws-tab-primary';
  primary.dataset.i18nKey = `workspace.${workspaceId}`;
  primary.textContent = t(`workspace.${workspaceId}`);

  const sub = document.createElement('span');
  sub.className = 'ws-tab-sub';
  sub.dataset.i18nKey = `workspace.${workspaceId}.sub`;
  sub.textContent = t(`workspace.${workspaceId}.sub`);

  btn.append(primary, sub);
  return btn;
}
```

CSS for `.ws-tab-sub` ships in PR3 (it's currently `display: none` by default — keep that in PR1 so zero pixel changes). In `src/styles/components/project.css` (or wherever the workspace tabs are styled) add:

```css
.ws-tab-sub { display: none; }    /* PR1: hidden; PR3 enables the furigana presentation */
```

- [ ] **Step 2: Hook LOCALE_CHANGED to re-translate the strip**

Same `_retranslate(panelRoot)` helper from Task 1.6.

- [ ] **Step 3: Commit**

```bash
git add src/ui/WorkspaceTabs.js src/styles/components/project.css
git commit -m "feat(i18n): workspace tabs carry primary + sub i18n keys"
```

---

### Task 1.8: `npm run i18n:check` validator script

**Files:**
- Create: `scripts/i18n-check.mjs`
- Modify: `package.json`

- [ ] **Step 1: Create `scripts/i18n-check.mjs`**

```js
#!/usr/bin/env node
// Verifies every t('key') call in src/ has a matching entry in en.json.
// JA / zh-Hant missing keys WARN (not fail) — translators fill incrementally.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import en from '../src/i18n/locales/en.json' with { type: 'json' };
import ja from '../src/i18n/locales/ja.json' with { type: 'json' };
import zhHant from '../src/i18n/locales/zh-Hant.json' with { type: 'json' };

const SRC = 'src';
const T_CALL = /\bt\(\s*['"]([^'"]+)['"]/g;
const DATA_KEY = /data-i18n-key=["']([^"']+)["']/g;

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, acc);
    else if (['.js', '.ts', '.mjs', '.html'].includes(extname(name))) acc.push(p);
  }
  return acc;
}

const used = new Set();
for (const file of walk(SRC)) {
  const text = readFileSync(file, 'utf8');
  for (const m of text.matchAll(T_CALL)) used.add(m[1]);
  for (const m of text.matchAll(DATA_KEY)) used.add(m[1]);
}
// Also scan index.html.
for (const m of readFileSync('index.html', 'utf8').matchAll(DATA_KEY)) used.add(m[1]);

let hadError = false;
const missingEn = [...used].filter(k => !(k in en));
if (missingEn.length) {
  hadError = true;
  console.error(`✗ ${missingEn.length} key(s) used in code but missing from en.json:`);
  for (const k of missingEn) console.error(`    ${k}`);
}

const warnJa = [...used].filter(k => k in en && !(k in ja));
const warnZh = [...used].filter(k => k in en && !(k in zhHant));
if (warnJa.length) console.warn(`! ${warnJa.length} key(s) missing from ja.json (fallback to EN at runtime)`);
if (warnZh.length) console.warn(`! ${warnZh.length} key(s) missing from zh-Hant.json (fallback to EN at runtime)`);

if (hadError) process.exit(1);
console.log(`✓ i18n: ${used.size} key(s) checked. ${warnJa.length + warnZh.length} translator gap(s).`);
```

- [ ] **Step 2: Add to `package.json` scripts**

Edit `package.json` so the `scripts` block includes:

```json
    "i18n:check": "node scripts/i18n-check.mjs",
```

- [ ] **Step 3: Run it**

```bash
npm run i18n:check
```

Expected: `✓ i18n: N key(s) checked. 0 translator gap(s).` (no missing-from-EN errors; warnings OK).

- [ ] **Step 4: Commit**

```bash
git add scripts/i18n-check.mjs package.json
git commit -m "ci(i18n): add i18n:check validator"
```

---

### Task 1.9: Make `src/ui/Toast.js` translate its messages at call sites (no API change yet)

> Hanko visual lands in PR3. PR1 only changes call sites so they pass already-translated strings (or `t('key')` results) into `Toast.show`. The Toast wrapper itself stays untouched.

**Files (sweep):** every `Toast.show('...'` call site

- [ ] **Step 1: grep for raw Toast.show calls**

```bash
grep -rn "Toast\.show\(['\"]" src
```

- [ ] **Step 2: For each call, wrap the literal in `t()`**

Example before:
```js
Toast.show(`Exported ${filename}`, 'success');
```
After:
```js
import { t } from '../i18n/index.js';
Toast.show(t('toast.exported', { filename }), 'success');
```

Add missing keys to all three locale files; for keys without a JA / zh-Hant translation, leave the value as `""` (validator warns, runtime falls back to EN).

- [ ] **Step 3: Run i18n validator + smoke the dev server**

```bash
npm run i18n:check
npm run dev
```

Trigger one toast (e.g., trigger an export), confirm the message renders in the active locale.

- [ ] **Step 4: Commit**

```bash
git add src/**/*.js src/i18n/locales/*.json
git commit -m "feat(i18n): translate Toast.show call sites"
```

---

### Task 1.10: Adapt existing 78 headless tests to assert by `data-i18n-key`, not literal text

> Most existing tests do not query DOM by visible text. Only adapt the ones that DO. Run the suite once to find them.

**Files:** `tests/*.test.mjs`

- [ ] **Step 1: Run the suite as-is**

```bash
npm test
```

Note any failures whose error message references a literal label like `'Properties'`, `'Scene'`, `'Export'`. Those need adapting.

- [ ] **Step 2: For each failing test, rewrite the assertion**

Before:
```js
assert.equal(panel.querySelector('.rp-title').textContent, 'Properties');
```
After:
```js
assert.equal(panel.querySelector('.rp-title')?.dataset.i18nKey, 'panel.properties.title');
```

- [ ] **Step 3: Re-run the suite**

```bash
npm test
```

Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add tests
git commit -m "test(i18n): assert by data-i18n-key, not literal text"
```

---

### Task 1.11: PR1 final smoke + merge tag

- [ ] **Step 1: Run the full suite + validator**

```bash
npm test
npm run i18n:check
```

Both green.

- [ ] **Step 2: Live smoke in Chrome with all three locales**

```bash
npm run dev
```

- `http://127.0.0.1:5173/?locale=en` — confirm every label is the same as before this PR.
- `?locale=ja` — confirm JA labels, `<html lang="ja">`, header switcher reads "日本語".
- `?locale=zh-Hant` — confirm zh-Hant labels.

- [ ] **Step 3: Open PR, get review, merge**

```bash
git push -u origin feat/i18n
gh pr create --title "feat(i18n): add EN / JA / zh-Hant with detection + switcher" --body "$(cat <<'EOF'
## Summary
- New \`src/i18n/\` module: \`t(key, params)\`, \`setLocale\`, \`getLocale\`, \`detectLocale\`, \`init\`, \`applyHtmlLang\`, \`SUPPORTED\`.
- Three locale files: \`en.json\` (source of truth), \`ja.json\`, \`zh-Hant.json\`.
- Browser-language detection on first boot (\`navigator.languages\` ordered scan), user override via header \`<select>\`, persistence in \`localStorage["mx-locale-v1"]\` (own key, independent of settings).
- ICU-lite \`{n, plural, ...}\` mini-parser (≤30 LOC, zero deps) backed by \`Intl.PluralRules\`.
- Visible UI strings tagged with \`data-i18n-key\`; existing tests adapted.
- New \`npm run i18n:check\` validator.

Zero visual change in this PR. PR2 swaps the visual tokens; PR3 adds the playful layer.

## Test plan
- [ ] \`npm test\` green
- [ ] \`npm run i18n:check\` green
- [ ] EN / JA / zh-Hant live in Chrome
- [ ] Switcher persists across reload
- [ ] \`?locale=ja\` URL override does NOT pollute stored preference

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: After merge, tag the head commit**

```bash
git checkout main
git pull
git tag -a i18n-shipped -m "PR1 (i18n) merged"
git push origin i18n-shipped
```

---

## PR2 — Visual (washi + Yuji + stone accent)

**Branch:** `feat/wafu-visual`
**Tag on merge:** `wafu-visual-shipped`

### Task 2.1: Rewrite `src/styles/tokens.css` with the washi palette

**Files:**
- Modify: `src/styles/tokens.css` (full rewrite)

- [ ] **Step 1: Replace the entire contents with the washi token set**

```css
:root {
  /* Washi surfaces — warm off-white paper, slight cream undertone. The
     panel hierarchy stays a 5-step ramp so existing components that read
     --bg-0..4 keep their relative layering. */
  --bg-0: #efe7d8;
  --bg-1: #f3ecdf;
  --bg-2: #f7f1e5;
  --bg-3: #fbf6ec;
  --bg-4: #fffaf0;

  /* Sumi text — never pure black, slightly warm. */
  --text-0: #1a1612;
  --text-1: #4a3f33;
  --text-2: #7a6a58;
  --text-disabled: #a99e8c;

  /* Dark stone accent — quiet wabi-sabi brown. */
  --accent:    #3e2c1e;
  --accent-hi: #5c4633;
  --accent-fg: #fbf6ec;

  /* Secondary "active" cue — bengara red-orange. Required because brown-on-
     washi is low-contrast for selection state; pairing the stone border with
     a bengara left-edge + faint bg tint restores the readable affordance. */
  --active:    #a23a2a;
  --active-bg: rgba(162, 58, 42, 0.10);

  /* Hairlines — kasumi cloud tones, softer than 1px solid. */
  --border:         #d4c9b3;
  --border-strong:  #b8a98c;
  --border-section: #c9bda2;
  --border-focus:   var(--active);
  --ring-focus:     rgba(162, 58, 42, 0.28);

  /* Control language — fields sit slightly inset against the panel. */
  --ctl-bg:        #fbf6ec;
  --ctl-bg-hover:  #fffaf0;
  --ctl-bg-active: #e9dfc8;
  --ctl-border:    #c9bda2;
  --ctl-h: 22px;

  /* Status — retuned for light bg readability. */
  --danger:  #c0392b;
  --warning: #b8860b;
  --success: #2e7d32;
  --info:    #1e3a5f;

  /* Typography */
  --font-display: "Yuji Syuku", "Shippori Mincho", serif;
  --font-sans:    system-ui, -apple-system, "Segoe UI", "Hiragino Sans",
                  "Yu Gothic UI", "Noto Sans CJK TC", sans-serif;
  --font-mono:    ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --fs-xs: 11px;
  --fs-sm: 12px;
  --fs-md: 13px;
  --fs-lg: 15px;
  --fs-xl: 18px;

  /* Spacing — unchanged from Blender baseline. */
  --sp-1: 2px;
  --sp-2: 4px;
  --sp-3: 6px;
  --sp-4: 8px;
  --sp-5: 12px;
  --sp-6: 16px;
  --sp-7: 24px;

  /* Radii — unchanged. */
  --r-sm: 4px;
  --r-md: 6px;
  --r-lg: 8px;

  /* Motion — unchanged. */
  --ease: cubic-bezier(0.4, 0, 0.2, 1);
  --dur-fast: 120ms;
  --dur-med:  200ms;

  /* Shadows — lifted off light bg, less heavy than dark theme. */
  --shadow-md: 0 4px 12px rgba(62, 44, 30, 0.18);
  --shadow-lg: 0 12px 32px rgba(62, 44, 30, 0.28);
}

html, body {
  background: var(--bg-0);
  color: var(--text-0);
  font: var(--fs-md)/1.5 var(--font-sans);
  margin: 0;
  height: 100vh;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}
```

- [ ] **Step 2: Smoke in dev**

```bash
git checkout -b feat/wafu-visual
npm run dev
```

Reload `http://127.0.0.1:5173/`. The whole UI should now read as a washi-light surface with stone-brown accents and bengara active highlights. Don't move on until the panel hierarchy still visually separates (Properties tier 1 → sub-sections tier 2 → sub-groups tier 3 still readable on the lighter palette).

- [ ] **Step 3: Commit**

```bash
git add src/styles/tokens.css
git commit -m "feat(theme): washi tokens replace Blender-dark palette"
```

---

### Task 2.2: Active-cue selectors (bengara left edge + bg tint)

**Files:**
- Modify: `src/styles/blender.css` (will be renamed in Task 2.4 — adding selectors first keeps the rename a pure mv)

> Add a new rule block at the end of `blender.css` for the secondary cue. This is mandatory (spec §Active-state contrast fix).

- [ ] **Step 1: Append the active-cue block**

At the end of `src/styles/blender.css`:

```css
/* 10. Active state — secondary bengara cue on washi (low brown-on-washi
   contrast otherwise). Applied to outliner row selection, list-item
   selection, and any element carrying .is-active or .selected. */
.ol-row.is-selected,
.ol-row.is-active,
.list-row.is-selected,
.list-row.is-active,
[data-active="true"] {
  background: var(--active-bg);
  box-shadow: inset 3px 0 0 var(--active);
}

/* Toggle "on" — keep stone border, lift bg with bengara tint. */
.pp-toggle.pp-toggle-on {
  background: color-mix(in srgb, var(--active) 10%, var(--ctl-bg));
}

/* Focus ring across all controls — bengara alpha. */
:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}
```

- [ ] **Step 2: Verify selectable rows still pop after the change**

Live smoke: import a model, click items in the outliner, confirm the active row reads clearly (3px bengara left edge + faint salmon bg).

- [ ] **Step 3: Commit**

```bash
git add src/styles/blender.css
git commit -m "feat(theme): secondary bengara active cue"
```

---

### Task 2.3: Yuji Syuku font load + display-target selectors

**Files:**
- Modify: `index.html` (preload + async stylesheet)
- Modify: `src/styles/blender.css` (apply `--font-display` to header / section headers / tabs)
- Create: `public/fonts/YujiSyuku-Regular.woff2` (download from Google Fonts as the CSP fallback)

- [ ] **Step 1: Download the Yuji Syuku woff2**

```bash
curl -L "https://fonts.gstatic.com/s/yujisyuku/v18/BngNUXNETFLImrpUcOIvUaJoIBVf5Ye2lQ.woff2" \
  -o public/fonts/YujiSyuku-Regular.woff2
```

(URL from `https://fonts.googleapis.com/css2?family=Yuji+Syuku&display=swap` — fetch that CSS first if the v18 number drifts; either way the file is the latin block since the brand/header is the main use case and the JA characters land via the system stack fallback for body text.)

- [ ] **Step 2: Add `@font-face` + Google Fonts async link in `index.html`**

Inside `<head>`, BEFORE the `<link>` to `tokens.css`:

```html
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Yuji+Syuku&display=swap"
        media="print"
        onload="this.media='all'">
  <noscript><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Yuji+Syuku&display=swap"></noscript>
```

- [ ] **Step 3: Add a self-hosted `@font-face` fallback in `tokens.css`**

At the very top of `src/styles/tokens.css`:

```css
@font-face {
  font-family: "Yuji Syuku";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: local("Yuji Syuku"),
       url("/fonts/YujiSyuku-Regular.woff2") format("woff2");
}
```

- [ ] **Step 4: Apply display font to display targets in `blender.css`**

Append:

```css
/* 11. Display typography — Yuji Syuku for headings + brand + workspace tabs.
   Body, inputs, viewport HUD stay --font-sans. Numerics stay --font-mono.
   Kept off inputs because Yuji's brush stroke hurts precision-tool legibility. */
.rp-section-header,
.pp-section-header,
.sp-section-header,
.ol-header,
.ws-tab-primary,
.modal-header,
#app-logo {
  font-family: var(--font-display);
  letter-spacing: 0.01em;
}
```

- [ ] **Step 5: Live smoke**

```bash
npm run dev
```

Open the app — section headers + workspace tab primary labels render in Yuji Syuku. Body / fields / HUD stay system sans.

- [ ] **Step 6: Commit**

```bash
git add index.html src/styles/tokens.css src/styles/blender.css public/fonts/YujiSyuku-Regular.woff2
git commit -m "feat(theme): Yuji Syuku on display targets"
```

---

### Task 2.4: Rename `blender.css` → `wafu.css`

**Files:**
- Rename: `src/styles/blender.css` → `src/styles/wafu.css`
- Modify: `index.html`

- [ ] **Step 1: git-rename the file**

```bash
git mv src/styles/blender.css src/styles/wafu.css
```

- [ ] **Step 2: Update the top-of-file comment**

In `src/styles/wafu.css`, change the leading comment from `/* ── Blender-inspired control language ───…` to:

```css
/* ── Wafu (和風) control language ─────────────────────────────────────────
   Loaded LAST so it wins the cascade. Selectors are inherited from the
   previous Blender-inspired layer (kept verbatim so component CSS still
   targets .pp-toggle, .rp-section-header etc. unchanged). Token rewrite
   in tokens.css does the heavy lift; this file just keeps the control
   language consistent under the new palette. PR3 appends the texture /
   pattern / mascot / hanko layers below. */
```

- [ ] **Step 3: Update `index.html`**

Change:
```html
  <link rel="stylesheet" href="/src/styles/blender.css">
```
to:
```html
  <link rel="stylesheet" href="/src/styles/wafu.css">
```

- [ ] **Step 4: Search for stragglers**

```bash
grep -rn "blender\.css" .
```

Expected: zero matches.

- [ ] **Step 5: Live smoke**

```bash
npm run dev
```

UI looks identical to end of Task 2.3 (CSS unchanged, only the file name).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(theme): rename blender.css → wafu.css (no content change)"
```

---

### Task 2.5: Viewport gradient + selection outline color update

**Files:**
- Modify: `src/core/scene/SceneConstants.js`

- [ ] **Step 1: Write the failing test FIRST**

Create `tests/scene-constants.test.mjs`:

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as SC from '../src/core/scene/SceneConstants.js';

test('viewport gradient = warm washi (sand top → paper bottom)', () => {
  assert.equal(SC.BG_GRADIENT_TOP,    '#dcd0b4');
  assert.equal(SC.BG_GRADIENT_BOTTOM, '#f5eedc');
});

test('selection outline colors moved to wafu palette', () => {
  assert.equal(SC.OUTLINE_ACTIVE_HEX,   '#a23a2a');   // bengara
  assert.equal(SC.OUTLINE_SELECTED_HEX, '#3e2c1e');   // stone
});

test('default light-rig defaults retuned for light bg', () => {
  assert.equal(SC.KEY_INTENSITY,   0.55);
  assert.equal(SC.HEMI_INTENSITY,  0.55);
  assert.equal(SC.TONE_EXPOSURE,   0.95);
  assert.equal(SC.SHADOW_DARKNESS, 0.45);
});
```

- [ ] **Step 2: Run, confirm it fails**

```bash
npm test -- tests/scene-constants.test.mjs
```

Expected: FAIL.

- [ ] **Step 3: Apply edits to `src/core/scene/SceneConstants.js`**

```js
// Wafu viewport — warm washi vertical wash (sand → paper).
export const BG_GRADIENT_TOP    = '#dcd0b4';
export const BG_GRADIENT_BOTTOM = '#f5eedc';
// Dark variant kept for future opt-in (Scene ▸ Render background toggle).
export const BG_DARK_TOP    = '#3c4046';
export const BG_DARK_BOTTOM = '#1e2126';

// Light rig retune for the light background (spec PR2 §Light rig retune).
export const HEMI_INTENSITY     = 0.55;
export const HEMI_GROUND_COLOR  = '#d4c9b3';
export const KEY_INTENSITY      = 0.55;
export const FILL_INTENSITY     = 0.25;
export const SHADOW_DARKNESS    = 0.45;
export const SHADOW_BLUR_KERNEL = 32;
export const TONE_CONTRAST      = 1.10;
export const TONE_EXPOSURE      = 0.95;

// Two-tone selection outline tuned for the washi bg.
export const OUTLINE_ACTIVE_HEX   = '#a23a2a';   // bengara (active)
export const OUTLINE_SELECTED_HEX = '#3e2c1e';   // stone (selected)
```

- [ ] **Step 4: Re-run test**

```bash
npm test -- tests/scene-constants.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Live smoke**

```bash
npm run dev
```

Reload, confirm viewport reads as warm vertical wash (no blue). Import an STL, select two meshes — confirm active outline is bengara, the secondary selection outline is stone.

- [ ] **Step 6: Commit**

```bash
git add src/core/scene/SceneConstants.js tests/scene-constants.test.mjs
git commit -m "feat(theme): viewport gradient + selection outline → wafu palette"
```

---

### Task 2.6: Retune `config/default-settings.json` light rig

**Files:**
- Modify: `src/config/default-settings.json`

- [ ] **Step 1: Update `tests/settings-store.test.mjs` to pin the new factory values**

Append a test that fails until the JSON is updated:

```js
test('factory render defaults match the wafu retune', () => {
  assert.equal(DEFAULTS.render.keyIntensity,   0.55);
  assert.equal(DEFAULTS.render.hemiIntensity,  0.55);
  assert.equal(DEFAULTS.render.exposure,       0.95);
  assert.equal(DEFAULTS.render.shadowDarkness, 0.45);
});
```

- [ ] **Step 2: Run, confirm it fails**

```bash
npm test -- tests/settings-store.test.mjs
```

Expected: FAIL on the new test.

- [ ] **Step 3: Edit `src/config/default-settings.json`**

```json
{
  "render": {
    "exposure": 0.95,
    "contrast": 1.10,
    "shadowsEnabled": true,
    "shadowDarkness": 0.45,
    "background": "light",
    "keyIntensity": 0.55,
    "fillIntensity": 0.25,
    "hemiIntensity": 0.55,
    ...
  }
}
```

(Only the four fields listed in the table change. Leave every other field at its current value.)

- [ ] **Step 4: Re-run tests**

```bash
npm test
```

Expected: all green (the new pin + the existing `INITIAL_STATE` mirror test both stay green because INITIAL_STATE reads from default-settings.json).

- [ ] **Step 5: Commit**

```bash
git add src/config/default-settings.json tests/settings-store.test.mjs
git commit -m "feat(theme): retune factory light rig for light bg"
```

---

### Task 2.7: PR2 final smoke + merge tag

- [ ] **Step 1: Run the full suite**

```bash
npm test
npm run i18n:check
```

Both green.

- [ ] **Step 2: Live smoke in Chrome**

- All three locales still readable (visual change does not regress text legibility).
- Viewport reads as warm washi wash.
- Active outliner row pops with bengara left edge.
- Selected mesh outline is bengara (active) + stone (selected).
- Section headers render in Yuji Syuku.

- [ ] **Step 3: Open PR, get review, merge**

```bash
git push -u origin feat/wafu-visual
gh pr create --title "feat(theme): washi-light tokens + Yuji + viewport retune" --body "$(cat <<'EOF'
## Summary
- \`tokens.css\` rewritten: washi paper surfaces, sumi text, stone-brown accent, bengara secondary active cue.
- Yuji Syuku on display targets (section headers, workspace tab labels, modal headers, brand) with self-hosted woff2 fallback.
- \`blender.css\` → \`wafu.css\` (selectors preserved verbatim).
- Viewport gradient: warm washi vertical wash.
- Light rig retuned for light bg: key 0.55, hemi 0.55, exposure 0.95, shadowDarkness 0.45.

## Test plan
- [ ] \`npm test\` green
- [ ] \`npm run i18n:check\` green
- [ ] Viewport reads warm washi
- [ ] Selection outline reads bengara/stone two-tone
- [ ] Yuji Syuku on section headers

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: After merge, tag the head commit**

```bash
git checkout main
git pull
git tag -a wafu-visual-shipped -m "PR2 (visual) merged"
git push origin wafu-visual-shipped
```

---

## PR3 — Playful (textures + koi + hanko + sound + furigana)

**Branch:** `feat/wafu-playful`
**Tag on merge:** `wafu-full-shipped`

### Task 3.1: Add `ui` slice to `default-settings.json` + StateManager + SettingsStore

**Files:**
- Modify: `src/config/default-settings.json`
- Modify: `src/core/StateManager.js` (extend `INITIAL_STATE.ui` with the two new flags from `DS.ui`)
- Modify: `src/core/SettingsStore.js` (add `ui` slice + `appearance` SECTION)
- Create: `tests/ui-slice.test.mjs`

- [ ] **Step 1: Write the failing test**

```js
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { installEnv } from './env.mjs';
installEnv();
const SS = await import('../src/core/SettingsStore.js');
const SM = await import('../src/core/StateManager.js');
import DS from '../src/config/default-settings.json' with { type: 'json' };

test('default-settings.json carries a "ui" slice', () => {
  assert.equal(DS.ui.mascotEnabled, true);
  assert.equal(DS.ui.soundEnabled, false);
});

test('INITIAL_STATE.ui carries the playful flags from config', () => {
  const s = SM.freshState();
  assert.equal(s.ui.mascotEnabled, true);
  assert.equal(s.ui.soundEnabled, false);
});

test('pickSettings persists the ui slice', () => {
  const s = SM.freshState();
  s.ui.mascotEnabled = false;
  const picked = SS.pickSettings(s);
  assert.deepEqual(picked.ui, { mascotEnabled: false, soundEnabled: false });
});

test('appearance section reset restores factory ui flags', () => {
  let s = SM.freshState();
  s.ui.mascotEnabled = false;
  s.ui.soundEnabled  = true;
  s = SS.applySectionToState(s, 'appearance');
  assert.equal(s.ui.mascotEnabled, true);
  assert.equal(s.ui.soundEnabled, false);
});
```

- [ ] **Step 2: Run, confirm it fails**

```bash
npm test -- tests/ui-slice.test.mjs
```

Expected: FAIL — missing `ui` block.

- [ ] **Step 3: Edit `src/config/default-settings.json`** — append a `ui` block:

```json
  "ui": {
    "mascotEnabled": true,
    "soundEnabled": false
  }
```

- [ ] **Step 4: Edit `src/core/StateManager.js`** — extend the `ui:` block in `INITIAL_STATE`:

```js
  ui: {
    activePanel: 'properties', outlinerCollapsed: {}, assetPanelHeight: 220, scaleLocked: true,
    workspace: 'layout',
    panelCollapsed: {},
    mascotEnabled: DS.ui.mascotEnabled,
    soundEnabled:  DS.ui.soundEnabled,
  },
```

- [ ] **Step 5: Edit `src/core/SettingsStore.js`** — extend SCHEMA + SECTIONS:

Add a SCHEMA entry:

```js
  { key: 'ui',        path: ['ui'],                  fields: ['mascotEnabled', 'soundEnabled'] },
```

(insert in the array — its position doesn't matter, but keep it near the end for visual grouping).

Extend `SECTIONS`:

```js
  appearance:  [{ slice: 'ui' }],
```

- [ ] **Step 6: Re-run**

```bash
npm test
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git checkout -b feat/wafu-playful
git add src/config/default-settings.json src/core/StateManager.js src/core/SettingsStore.js tests/ui-slice.test.mjs
git commit -m "feat(state): add ui slice (mascotEnabled, soundEnabled) + appearance reset"
```

---

### Task 3.2: Texture SVGs + `wafu.css` append for washi grain / asanoha / seigaiha

**Files:**
- Create: `public/textures/washi.svg`
- Create: `public/textures/asanoha.svg`
- Create: `public/textures/seigaiha.svg`
- Modify: `src/styles/wafu.css` (append a `/* 12. Texture layer */` block)

- [ ] **Step 1: Create `public/textures/washi.svg`** — fibrous noise

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
  <filter id="f">
    <feTurbulence type="fractalNoise" baseFrequency="0.62" numOctaves="2" seed="3"/>
    <feColorMatrix values="0 0 0 0 0.18  0 0 0 0 0.14  0 0 0 0 0.08  0 0 0 0.06 0"/>
  </filter>
  <rect width="240" height="240" fill="#f3ecdf"/>
  <rect width="240" height="240" filter="url(#f)"/>
</svg>
```

- [ ] **Step 2: Create `public/textures/asanoha.svg`** — hex-star tile

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="60" height="69" viewBox="0 0 60 69">
  <g fill="none" stroke="#3e2c1e" stroke-width="0.6" stroke-linecap="round">
    <polygon points="30,3 56,18 56,51 30,66 4,51 4,18"/>
    <line x1="30" y1="3"  x2="30" y2="35"/>
    <line x1="56" y1="18" x2="30" y2="35"/>
    <line x1="56" y1="51" x2="30" y2="35"/>
    <line x1="30" y1="66" x2="30" y2="35"/>
    <line x1="4"  y1="51" x2="30" y2="35"/>
    <line x1="4"  y1="18" x2="30" y2="35"/>
  </g>
</svg>
```

- [ ] **Step 3: Create `public/textures/seigaiha.svg`** — wave tile

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40" viewBox="0 0 80 40">
  <g fill="none" stroke="#3e2c1e" stroke-width="0.8" stroke-opacity="0.45">
    <circle cx="0"  cy="40" r="20"/>
    <circle cx="40" cy="40" r="20"/>
    <circle cx="80" cy="40" r="20"/>
    <circle cx="20" cy="20" r="20"/>
    <circle cx="60" cy="20" r="20"/>
  </g>
</svg>
```

- [ ] **Step 4: Append the texture block to `src/styles/wafu.css`**

```css
/* 12. Texture layer — washi grain on body, asanoha on toggle-on, seigaiha
   on progress fills. Disabled under prefers-reduced-motion to avoid the
   subtle parallax illusion the fibres create on scroll. */
body {
  background-image: url("/textures/washi.svg");
  background-size: 240px 240px;
}
.pp-toggle.pp-toggle-on::after {
  content: "";
  position: absolute;
  inset: 0;
  pointer-events: none;
  background-image: url("/textures/asanoha.svg");
  background-size: 60px 69px;
  opacity: 0.12;
  border-radius: inherit;
}
.pp-toggle { position: relative; }
.progress-fill::before {
  content: "";
  position: absolute;
  inset: 0;
  background-image: url("/textures/seigaiha.svg");
  background-size: 80px 40px;
  background-repeat: repeat-x;
  background-position: 0 50%;
  opacity: 0.4;
  animation: seigaiha-slide 6s linear infinite;
}
@keyframes seigaiha-slide {
  from { background-position-x: 0; }
  to   { background-position-x: 80px; }
}
@media (prefers-reduced-motion: reduce) {
  .progress-fill::before { animation: none; }
}
```

- [ ] **Step 5: Live smoke**

```bash
npm run dev
```

Confirm body has a faint paper grain; enable HDRI (a toggle) and see asanoha at 12% opacity inside the pressed pill; export to trigger the progress bar — wave tile slides.

- [ ] **Step 6: Commit**

```bash
git add public/textures src/styles/wafu.css
git commit -m "feat(theme): washi / asanoha / seigaiha textures"
```

---

### Task 3.3: Koi mascot

**Files:**
- Create: `public/koi.svg`
- Create: `src/ui/Mascot.js`
- Modify: `src/styles/wafu.css` (append mascot CSS)
- Modify: `src/app/main.ts` (call `Mascot.init()`)

- [ ] **Step 1: Create `public/koi.svg`** — two-layer (body + fin)

```xml
<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60" viewBox="0 0 120 60">
  <g id="koi-body" fill="#a23a2a">
    <path d="M10,30 C20,10 60,10 80,22 C95,30 102,40 110,30 C100,40 90,46 70,46 C40,46 20,40 10,30 Z"/>
    <ellipse cx="78" cy="26" rx="2.4" ry="2.4" fill="#1a1612"/>
    <path d="M22,30 C30,22 50,22 60,28 C50,30 35,32 22,30 Z" fill="#fffaf0" opacity="0.85"/>
  </g>
  <g id="koi-fin" fill="#a23a2a" opacity="0.85">
    <path d="M2,30 C6,18 14,18 16,30 C14,42 6,42 2,30 Z" transform-origin="14 30"/>
  </g>
</svg>
```

- [ ] **Step 2: Create `src/ui/Mascot.js`**

```js
import { subscribe, getState } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';

let _el = null;
let _swimAnim = null;

function _shouldRun() {
  const ui = getState().ui ?? {};
  if (!ui.mascotEnabled) return false;
  if (typeof window !== 'undefined'
      && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  return true;
}

function _shouldShow() {
  return Object.keys(getState().scene?.objects ?? {}).length === 0;
}

function _mount() {
  if (_el) return;
  const host = document.getElementById('viewport');
  if (!host) return;
  const wrap = document.createElement('div');
  wrap.className = 'mx-koi';
  wrap.setAttribute('aria-hidden', 'true');
  wrap.innerHTML = `
    <object type="image/svg+xml" data="/koi.svg" tabindex="-1" aria-hidden="true"></object>
  `;
  host.appendChild(wrap);
  _el = wrap;
}

function _unmount() {
  _el?.remove();
  _el = null;
  _swimAnim?.cancel?.();
  _swimAnim = null;
}

function _onImport() {
  if (!_el) return;
  _el.classList.add('mx-koi-swim');
  // Animation listed in wafu.css. Unmount after the swim runs once.
  _swimAnim = setTimeout(_unmount, 8000);
}

function _onSnap() {
  if (!_el) return;
  // Re-trigger the splash CSS animation by toggling the class.
  _el.classList.remove('mx-koi-splash');
  void _el.offsetWidth;     // force reflow to restart the keyframes
  _el.classList.add('mx-koi-splash');
}

function _sync() {
  if (_shouldRun() && _shouldShow()) _mount();
  else _unmount();
}

export function init() {
  _sync();
  subscribe(EVENTS.ASSET_INSTANTIATED, _onImport);
  subscribe(EVENTS.OBJECT_REMOVED,    _sync);
  subscribe(EVENTS.PROJECT_NEW,       _sync);
  subscribe(EVENTS.PROJECT_LOADED,    _sync);
  // Spec PR3 §Mascot called this CURSOR_SNAP; the existing event bus
  // only emits CURSOR_CHANGED (fires on every cursor move including snap).
  // v1 splashes on any cursor move — refinement to gate on snap-only can
  // ship later when Cursor3D exposes a dedicated snap event.
  subscribe(EVENTS.CURSOR_CHANGED,    _onSnap);
  subscribe(EVENTS.SETTINGS_RESET,    _sync);
}

export const Mascot = { init };
```

- [ ] **Step 3: Append CSS to `src/styles/wafu.css`**

```css
/* 13. Koi mascot — lower-right viewport corner, idle tail-wag, swim across
   on import, splash on snap. GPU-cheap (transform + opacity only). */
.mx-koi {
  position: absolute;
  right: 24px;
  bottom: 24px;
  width: 120px;
  height: 60px;
  pointer-events: none;
  z-index: 4;
  animation: koi-idle 6s ease-in-out infinite;
}
.mx-koi object { width: 100%; height: 100%; display: block; }

@keyframes koi-idle {
  0%, 100% { transform: translateY(0) rotate(-1deg); }
  50%      { transform: translateY(-4px) rotate(1deg); }
}

.mx-koi.mx-koi-swim {
  animation: koi-swim 8s ease-in-out forwards;
}
@keyframes koi-swim {
  0%   { transform: translateX(0) translateY(0); opacity: 1; }
  90%  { transform: translateX(-90vw) translateY(-10px); opacity: 1; }
  100% { transform: translateX(-95vw) translateY(0); opacity: 0; }
}

.mx-koi.mx-koi-splash::after {
  content: "";
  position: absolute;
  inset: -20px;
  border: 2px solid var(--active);
  border-radius: 50%;
  opacity: 0;
  animation: koi-splash 400ms ease-out;
}
@keyframes koi-splash {
  0%   { transform: scale(0.6); opacity: 0.8; }
  100% { transform: scale(1.6); opacity: 0; }
}

@media (prefers-reduced-motion: reduce) {
  .mx-koi { animation: none; }
}
```

- [ ] **Step 4: Wire `Mascot.init()` into `src/app/main.ts`** after other UI mounts:

```js
import { Mascot } from '../ui/Mascot.js';
// ...existing init chain...
Mascot.init();
```

- [ ] **Step 5: Live smoke**

```bash
npm run dev
```

Empty viewport: koi sits in lower-right and tail-wags. Import an STL: koi swims left, unmounts. Snap the 3D cursor (Shift+S or whichever shortcut already fires `CURSOR_CHANGED`): splash ring blooms.

- [ ] **Step 6: Commit**

```bash
git add public/koi.svg src/ui/Mascot.js src/styles/wafu.css src/app/main.ts
git commit -m "feat(playful): koi mascot — idle, swim on import, splash on snap"
```

---

### Task 3.4: Hanko stamp toast

**Files:**
- Create: `src/ui/Hanko.js`
- Modify: `src/ui/Toast.js` (delegate visual rendering to Hanko; keep the public API)
- Modify: `src/styles/wafu.css` (append `.hanko` rules)

- [ ] **Step 1: Add the two extra hanko keys to all three locale files**

`en.json`:
```json
"hanko.warning": "warning",
"hanko.working": "working",
```
`ja.json`:
```json
"hanko.warning": "注意",
"hanko.working": "処理中",
```
`zh-Hant.json`:
```json
"hanko.warning": "注意",
"hanko.working": "處理中",
```

- [ ] **Step 2: Create `src/ui/Hanko.js`**

```js
import { t, getLocale } from '../i18n/index.js';

// Map toast type → decorative kanji (always visible regardless of locale).
// These are pure UI glyphs, not translatable copy.
const KANJI = {
  success: '済',
  error:   '失',
  warning: '注',
  info:    '保',
  loading: '今',
};

// Map toast type → human-readable label key under `hanko.*`. EN/JA/zh-Hant
// fall through the normal t() chain.
const LABEL_KEY = {
  success: 'hanko.done',
  error:   'hanko.failed',
  warning: 'hanko.warning',
  info:    'hanko.saved',
  loading: 'hanko.working',
};

export function renderHanko(message, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast hanko hanko-${type}`;
  const kanji = document.createElement('span');
  kanji.className = 'hanko-kanji';
  kanji.textContent = KANJI[type] ?? KANJI.info;
  const label = document.createElement('span');
  label.className = 'hanko-label';
  label.textContent = message ?? t(LABEL_KEY[type] ?? 'hanko.saved');
  el.append(kanji, label);
  return el;
}

export const Hanko = { renderHanko };
```

- [ ] **Step 3: Modify `src/ui/Toast.js`** — replace the rendering function

Change `_render(id, message, type, onClick)` so it delegates to Hanko:

```js
import { renderHanko } from './Hanko.js';

function _render(id, message, type, onClick) {
  const el = renderHanko(message, type);
  el.dataset.id = id;
  if (typeof onClick === 'function') {
    el.classList.add('toast-clickable');
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    const activate = () => { dismiss(id); onClick(); };
    el.addEventListener('click', activate);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); }
    });
  }
  return el;
}
```

(Drop the old `TYPE_ICONS` import + the icon span — Hanko renders the kanji directly.)

- [ ] **Step 4: Append CSS to `src/styles/wafu.css`**

```css
/* 14. Hanko stamp — kanji on bengara square, drop-in slap. */
.toast.hanko {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-4);
  background: var(--bg-4);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  animation: hanko-drop 120ms cubic-bezier(0.34, 1.56, 0.64, 1);
}
.hanko-kanji {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: var(--active);
  color: var(--accent-fg);
  border-radius: 4px;
  font-family: var(--font-display);
  font-size: 18px;
  line-height: 1;
}
.hanko-label { color: var(--text-0); }

@keyframes hanko-drop {
  0%   { transform: scale(1.3) rotate(-4deg); opacity: 0; }
  100% { transform: scale(1)   rotate(0);     opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .toast.hanko { animation: none; opacity: 1; transform: none; }
}
```

- [ ] **Step 5: Live smoke** — trigger a toast (e.g., do an export, change reset). Stamp drops with a tiny overshoot. Reload at `?locale=ja` and confirm the label changes language.

- [ ] **Step 6: Commit**

```bash
git add src/ui/Hanko.js src/ui/Toast.js src/styles/wafu.css src/i18n/locales/*.json
git commit -m "feat(playful): hanko stamp toast"
```

---

### Task 3.5: Sound (lazy WebAudio on snap)

**Files:**
- Create: `public/sounds/tok.mp3` (any short tok/wood-block sample, ≤16 KB)
- Create: `src/ui/Sound.js`
- Modify: `src/app/main.ts` (call `Sound.init()`)

- [ ] **Step 1: Source a `tok.mp3` sample**

Use any CC0 / public-domain wood-block / kalimba pluck under 16 KB. Place at `public/sounds/tok.mp3` before continuing — `Sound.init()` does guard on fetch failure but a missing file shows a console warn on every snap, which is noise we don't want shipped.

- [ ] **Step 2: Create `src/ui/Sound.js`**

```js
import { subscribe, getState } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';

let _ctx = null;
let _buffer = null;
let _loading = false;

async function _ensureLoaded() {
  if (_buffer || _loading) return;
  _loading = true;
  try {
    _ctx = new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch('/sounds/tok.mp3');
    const bytes = await res.arrayBuffer();
    _buffer = await _ctx.decodeAudioData(bytes);
  } catch (err) {
    console.warn('[sound] failed to load tok.mp3:', err);
  } finally {
    _loading = false;
  }
}

function _play() {
  if (!getState().ui?.soundEnabled) return;
  _ensureLoaded().then(() => {
    if (!_buffer || !_ctx) return;
    const src = _ctx.createBufferSource();
    src.buffer = _buffer;
    src.connect(_ctx.destination);
    src.start(0);
  });
}

export function init() {
  subscribe(EVENTS.CURSOR_CHANGED, _play);
}

export const Sound = { init };
```

- [ ] **Step 3: Wire `Sound.init()` into `src/app/main.ts`** after `Mascot.init()`

- [ ] **Step 4: Live smoke**

Enable in Settings → Appearance → Sound (added in Task 3.7). Move the 3D cursor with a snap — single `tok` plays.

- [ ] **Step 5: Commit**

```bash
git add public/sounds/tok.mp3 src/ui/Sound.js src/app/main.ts
git commit -m "feat(playful): lazy WebAudio snap sound (opt-in)"
```

---

### Task 3.6: Furigana on workspace tabs (CSS enable)

**Files:**
- Modify: `src/styles/wafu.css` (append `.ws-tab-sub` rules — DOM already carries the keys from PR1 Task 1.7)

- [ ] **Step 1: Append CSS**

```css
/* 15. Workspace tab furigana — small sub-label above/below the primary
   label (Yuji), system sans, muted. */
.ws-tab { display: inline-flex; flex-direction: column; align-items: center; line-height: 1; }
.ws-tab-primary { font-family: var(--font-display); font-size: var(--fs-md); }
.ws-tab-sub     {
  display: block;
  font-family: var(--font-sans);
  font-size: 9px;
  color: var(--text-2);
  letter-spacing: 0.05em;
  margin-top: 2px;
}
```

(Reminder: PR1 set `.ws-tab-sub { display: none; }` in `src/styles/components/project.css`. The wafu.css rule's cascade order takes precedence because wafu.css is loaded LAST. If specificity does not win, change the project.css rule to `display: none` only for `:lang(en)` or remove it now that PR2 has shipped — note: `:lang` switch fights with the locale-aware sub strings from spec, so just remove the original `display: none` and rely on this rule.)

- [ ] **Step 2: Remove the PR1 placeholder hide**

In `src/styles/components/project.css` (or wherever PR1 added it), delete:
```css
.ws-tab-sub { display: none; }
```

- [ ] **Step 3: Live smoke**

Three locales:
- `?locale=en` — Layout (Yuji) over 配置 (small).
- `?locale=ja` — レイアウト (Yuji) over Layout (small).
- `?locale=zh-Hant` — 配置 (Yuji) over Layout (small).

- [ ] **Step 4: Commit**

```bash
git add src/styles/wafu.css src/styles/components/project.css
git commit -m "feat(playful): furigana on workspace tabs"
```

---

### Task 3.7: Settings panel "Appearance" section

**Files:**
- Modify: `src/ui/ScenePanel.js` (add an Appearance sub-section at the bottom)
- Make sure `LocaleSwitcher` exposes a `mount` host parameter so it can render in two locations.

- [ ] **Step 1: Inspect where ScenePanel renders its sub-sections**

```bash
sed -n '1,60p' src/ui/ScenePanel.js
```

- [ ] **Step 2: Append a new sub-section**

Pattern (adapt to existing sub-section builder):

```js
import { LocaleSwitcher } from './LocaleSwitcher.js';
import { setState, getState } from '../core/StateManager.js';
import { SettingsStore } from '../core/SettingsStore.js';
import { t } from '../i18n/index.js';

function _renderAppearanceSection(parent) {
  const wrap = document.createElement('section');
  wrap.className = 'pp-section';
  wrap.innerHTML = `
    <button type="button" class="pp-section-header" aria-expanded="true">
      <span class="sec-icon"></span>
      <span class="pp-title" data-i18n-key="section.appearance">${t('section.appearance')}</span>
    </button>
    <div class="pp-body">
      <div class="pp-row">
        <label data-i18n-key="setting.locale">${t('setting.locale')}</label>
        <span class="pp-locale-host"></span>
      </div>
      <div class="pp-row">
        <label data-i18n-key="setting.mascot">${t('setting.mascot')}</label>
        <button type="button" class="pp-toggle pp-mascot-toggle">
          <span class="pp-toggle-dot"></span>
          <span data-i18n-key="setting.mascot">${t('setting.mascot')}</span>
        </button>
      </div>
      <div class="pp-row">
        <label data-i18n-key="setting.sound">${t('setting.sound')}</label>
        <button type="button" class="pp-toggle pp-sound-toggle">
          <span class="pp-toggle-dot"></span>
          <span data-i18n-key="setting.sound">${t('setting.sound')}</span>
        </button>
      </div>
    </div>
  `;
  parent.appendChild(wrap);
  LocaleSwitcher.mount(wrap.querySelector('.pp-locale-host'));

  const mascotBtn = wrap.querySelector('.pp-mascot-toggle');
  const soundBtn  = wrap.querySelector('.pp-sound-toggle');
  const syncBtn = (btn, on) => btn.classList.toggle('pp-toggle-on', !!on);

  syncBtn(mascotBtn, getState().ui.mascotEnabled);
  syncBtn(soundBtn,  getState().ui.soundEnabled);

  mascotBtn.addEventListener('click', () => {
    setState(s => ({ ...s, ui: { ...s.ui, mascotEnabled: !s.ui.mascotEnabled } }));
    SettingsStore.scheduleSave();
    syncBtn(mascotBtn, getState().ui.mascotEnabled);
  });
  soundBtn.addEventListener('click', () => {
    setState(s => ({ ...s, ui: { ...s.ui, soundEnabled: !s.ui.soundEnabled } }));
    SettingsStore.scheduleSave();
    syncBtn(soundBtn, getState().ui.soundEnabled);
  });
}

// Inside the existing renderScenePanel() / equivalent, after the last sub-section:
//   _renderAppearanceSection(panelRoot);
```

- [ ] **Step 3: Live smoke**

Open the Scene panel, find Appearance. Toggle Mascot off — koi disappears immediately. Toggle Sound on — snap plays. Switch locale via this secondary switcher — header switcher updates in sync.

- [ ] **Step 4: Commit**

```bash
git add src/ui/ScenePanel.js
git commit -m "feat(playful): Settings Appearance section (locale + mascot + sound)"
```

---

### Task 3.8: PR3 final smoke + merge tag

- [ ] **Step 1: Run the full suite + validator**

```bash
npm test
npm run i18n:check
```

Both green.

- [ ] **Step 2: Live smoke**

Run through everything end-to-end:
- Empty viewport: koi tail-wagging in corner.
- Import STL: koi swims off, gone after 8 s.
- 3D cursor snap (with sound off): silent splash ring; with sound on: tok.
- Trigger export: hanko stamps "済 / done" with overshoot.
- Switch locale to JA: hanko reads "完了"; workspace tabs show kanji on top + English subtitle.
- Switch to zh-Hant: hanko "完成", tabs 配置/Layout etc.
- Settings → Appearance: toggle mascot off, koi unmounts; reset section restores it on.

- [ ] **Step 3: Open PR, get review, merge**

```bash
git push -u origin feat/wafu-playful
gh pr create --title "feat(playful): koi + hanko + textures + sound + furigana" --body "$(cat <<'EOF'
## Summary
- Washi grain on body, asanoha pattern on toggle-on, seigaiha wave on progress.
- Koi mascot: idle tail-wag in empty viewport, swim-across on import, splash on snap. Gated by \`state.ui.mascotEnabled\` + \`prefers-reduced-motion\`.
- Hanko stamp toast replaces visual rendering inside Toast.js (API unchanged); kanji + locale-aware label, slap-overshoot drop, reduced-motion fallback.
- WebAudio snap sound — lazy-loaded, opt-in (default off).
- Furigana on workspace tabs (locale-aware primary + sub label, already wired in PR1).
- Settings → Appearance: locale switcher + mascot + sound, with per-section reset.

## Test plan
- [ ] \`npm test\` green
- [ ] \`npm run i18n:check\` green
- [ ] Koi shows on empty / swims on import
- [ ] Hanko drops with overshoot, kanji + locale label
- [ ] Snap sound plays only with sound enabled
- [ ] prefers-reduced-motion: no animations
- [ ] Appearance section reset restores factory ui slice

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 4: After merge, tag the head commit**

```bash
git checkout main
git pull
git tag -a wafu-full-shipped -m "PR3 (playful) merged — wafu initiative complete"
git push origin wafu-full-shipped
```

---

## Rollback ladder

| Symptom | Reset to |
|---|---|
| PR3 caused a regression | `git reset --hard wafu-visual-shipped` |
| PR2 caused a regression | `git reset --hard i18n-shipped` |
| Whole initiative needs to go | `git reset --hard pre-wafu-2026-06-14` |

Each tag is a working, tested state.
