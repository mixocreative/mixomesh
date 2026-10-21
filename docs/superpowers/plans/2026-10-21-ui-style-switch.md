# UI Style Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MIXOMESH gets a second UI style, New (mixo-app-style, Dense), default on, switchable with Original from the header.

**Architecture:** `data-ui-style="new|original"` on `<html>`, set before first paint by a classic script in `public/` (CSP forbids inline script). One new stylesheet `src/styles/style-new.css`, linked last, holds every New rule scoped under `:root[data-ui-style="new"]`: token remap first, then targeted overrides. Original = no attribute match = today's CSS untouched. `src/core/UiStyle.js` owns read/apply/persist; `src/ui/UiStyleSwitcher.js` mounts beside the locale picker.

**Tech Stack:** vanilla JS + CSS, Vite, node:test, CDP browser smokes, `@fontsource/zen-kaku-gothic-new` (OFL-1.1, local woff2 subsets).

**Spec:** `docs/superpowers/specs/2026-10-21-ui-style-switch-design.md`; values from skill `mixo-app-style` (`~/.agents/skills/mixo-app-style/tokens.css`, `base.css`).

## Global Constraints

- Storage key `mx-ui-style-v1`, value `{ "v": 1, "style": "new" | "original" }`; missing/invalid → `new`; storage access in try/catch.
- Original renders exactly as `main` except the new switch.
- New: paper `#f4f2ed`, surface `#fbfaf7`, sunken `#ebe8e1`, line `#dcd7cd`, line-strong `#c4bdb0`, ink `#3b3631`, muted `#8a847a`, red `#7f0019` / `#96102b`, danger `#b3261e`, warning `#b07a12`, success `#4a6b3a`, info `#3b4a5c`; radius 2px; rows 22px; body 11.5px; header 32px; panels 220/240px default.
- Red only: primary action, progress fill, number focus underline, current-item marker. Ink: active tab/segment, pressed, checked. Sunken: hover/selected row. Destructive: danger outline, never filled.
- No `box-shadow` in New except HUD glass (`--hud-*` tint/sheen/noise/border/shadow untouched). HUD takes font, sizes, ink/red states.
- Font Zen Kaku Gothic New 400/500 local; zh-Hant stack `'PingFang TC','Noto Sans TC','Microsoft JhengHei','Zen Kaku Gothic New'`. No runtime Google Fonts.
- CSP unchanged (`script-src 'self'`, `style-src 'self'`).
- i18n: every new string in en / ja / zh-Hant; `npm run i18n:check` green.

## Review Focus

- A storage value from a future version (`{v:2,...}`) or garbage → boots New, no throw. (Task 1 test.)
- Switching style while a modal/popover is open → it restyles in place, nothing re-mounts. (Task 5 smoke toggles with the print modal open if reachable; else manual check in Task 4.)
- ja / zh-Hant labels at 11.5px in a 240px panel → wrap, not clip. (Task 4 screenshots, all locales.)
- Phone layout (`responsive.css` ≤ 700px) in New → still usable. (Task 4 screenshot `390x844`.)
- Electron `file://` build → fonts and boot script resolve with relative paths. (Task 5 `npm run test:electron`.)

---

### Task 1: UiStyle core + pre-paint boot script

**Files:**
- Create: `src/core/UiStyle.js`, `public/ui-style-boot.js`, `tests/ui-style.test.mjs`
- Modify: `index.html` (classic `<script src="./ui-style-boot.js"></script>` in `<head>` before the first stylesheet), `public/sw.js` (add `'./ui-style-boot.js'` to `PRECACHE`, bump `CACHE_VERSION` to `'v2'`), `src/core/events.js` (add `UI_STYLE_CHANGED: 'ui:styleChanged'`)

**Interfaces:**
- Produces: `UI_STYLES = ['new','original']`, `STORAGE_KEY = 'mx-ui-style-v1'`, `readStyle(storage?) -> 'new'|'original'`, `applyStyle(style, root?) -> void` (sets `root.dataset.uiStyle`), `getStyle() -> style`, `setStyle(style) -> void` (normalise, persist, apply, dispatch `EVENTS.UI_STYLE_CHANGED` `{ style }`; no-op if unchanged).
- `public/ui-style-boot.js`: IIFE, same read logic, sets `document.documentElement.dataset.uiStyle`; never throws.

- [ ] Step 1: tests — `readStyle` returns `'new'` for: empty storage, `'{bad'`, `{v:1,style:'weird'}`, storage whose `getItem` throws; returns `'original'` for `{v:1,style:'original'}`; `applyStyle('original', fakeRoot)` sets `fakeRoot.dataset.uiStyle === 'original'`; boot script evaluated via `new Function('document','localStorage', src)` with stubs sets `dataset.uiStyle` to `'new'` / `'original'` correctly and survives a throwing `localStorage`.
- [ ] Step 2: `npm test` → new tests FAIL (module missing).
- [ ] Step 3: implement both files + index/sw/events edits.
- [ ] Step 4: `npm test` → PASS; `npm run lint`, `npm run typecheck` green.
- [ ] Step 5: commit `feat(ui): ui style state and pre-paint boot`.

### Task 2: Style switcher in the header

**Files:**
- Create: `src/ui/UiStyleSwitcher.js`
- Modify: `index.html` (`<span id="ui-style-switcher-host"></span>` right after `#locale-switcher-host`), `src/ui/AppShell.js` (mount + refresh on `LOCALE_CHANGED`), `src/i18n/locales/{en,ja,zh-Hant}.json`

**Interfaces:**
- Consumes: Task 1 `getStyle`, `setStyle`, `UI_STYLES`.
- Produces: `<select id="ui-style-switcher">` with options `new`, `original`; `UiStyleSwitcher.mount(host)`, `.refresh(host)` mirroring `LocaleSwitcher`.
- Keys: `setting.uiStyle` = "Interface style" / "画面スタイル" / "介面風格"; `uiStyle.new` = "New" / "新" / "新版"; `uiStyle.original` = "Original" / "オリジナル" / "原版".

- [ ] Step 1: `npm run i18n:check` after adding keys → green.
- [ ] Step 2: implement switcher; reuse the locale `<select>` styling (shared class or `#locale-switcher, #ui-style-switcher` selector) so Original looks native.
- [ ] Step 3: `npm test`, `npm run lint` green.
- [ ] Step 4: commit `feat(ui): header switch between New and Original styles`.

### Task 3: Bundled font

**Files:**
- Modify: `package.json` (dependency `@fontsource/zen-kaku-gothic-new`), create `src/styles/style-new.css` starting with `@import '@fontsource/zen-kaku-gothic-new/400.css'; @import '@fontsource/zen-kaku-gothic-new/500.css';`, link it in `index.html` as the LAST stylesheet.

- [ ] Step 1: `npm install @fontsource/zen-kaku-gothic-new`.
- [ ] Step 2: `npm run build` → woff2 files land in `dist/assets`, no request to fonts.googleapis.com (grep dist).
- [ ] Step 3: commit `build: bundle Zen Kaku Gothic New locally`.

### Task 4: New style sheet

**Files:**
- Modify: `src/styles/style-new.css`

Order inside the file (all under `:root[data-ui-style="new"]`):
1. Token remap of `tokens.css`: `--bg-0..2` → paper, `--bg-3` → surface, `--bg-4` → `#fff`; `--text-0/1` → ink, `--text-2` → muted, `--text-disabled` → `#b4aea4`; `--accent` → red, `--accent-hi` → red-hover, `--accent-fg` → `#fff`; `--active` → ink, `--active-bg` → sunken; borders → line / line-strong / line; `--border-focus` → ink; `--ring-focus` → `rgba(59,54,49,.25)`; `--ctl-bg` surface, `--ctl-bg-hover` `#fff`, `--ctl-bg-active` sunken, `--ctl-border` line; status colours per Global Constraints; `--font-sans` per skill; `--fs-xs..xl` 10.5/11/11.5/13/15; `--r-sm/md/lg` 2px; `--shadow-md/lg`, `--sheet-shadow` → none; `--outliner-width` 220px, `--right-panel-width` 240px. Plus the zh-Hant font rule.
2. Flat surfaces: modals, popovers, sheets, menus get `border: 1px solid var(--border)` where their shadow carried the edge.
3. Ink vs red fixes for selectors the token remap gets wrong: `.ws-btn.active`, `.pp-tab.active`, `.pp-seg-btn[aria-checked="true"]`, `.cm-item[aria-expanded="true"]` → ink fill / paper text; `.ol-selected` → sunken, no edge; `.ol-active` → red marker; primary buttons → red; destructive buttons → danger outline.
4. Density: header 32px, section/panel padding 8px / 6px, row min-height 22px.
5. HUD: leave `--hud-*` alone; verify `.vp-toggles .vt-btn.vt-on` reads as ink.

- [ ] Step 1: find the selectors: `grep -n "box-shadow\|#[0-9a-f]\{3,8\}" src/styles -r` and the active/selected classes above; list any literal colours outside tokens.
- [ ] Step 2: write the sheet.
- [ ] Step 3: capture `SIZES="1366x1024,1024x768,390x844" node scripts/ui-screenshot.mjs .tmp/shots-new` with New, and the same with Original into `.tmp/shots-original`; check New against the spec's "Done when" (no brown/bengara, no non-HUD shadows, nothing clipped) in en / ja / zh-Hant; check Original against a `main` capture.
- [ ] Step 4: `npm test`, `npm run lint`, `npm run test:browser` green.
- [ ] Step 5: commit `feat(ui): New style (mixo-app-style, dense)`.

### Task 5: Style smoke + docs

**Files:**
- Modify: `tests/browser-smoke.mjs` (or new `tests/browser-ui-style-smoke.mjs` + script `test:ui-style`), `DESIGN.md` (pointer: New style values come from `mixo-app-style`), `.gitignore` (`.superpowers/`), `HANDOFF.md` per repo protocol.

- [ ] Step 1: smoke — fresh profile → `document.documentElement.dataset.uiStyle === 'new'`; select `original` → attribute + stored JSON updated, `getComputedStyle(document.body).backgroundColor` changes; reload → still `original`; select `new` → `rgb(244, 242, 237)` body background.
- [ ] Step 2: run it → PASS; `npm run test:all` green; `npm run test:electron` green.
- [ ] Step 3: commit `test(ui): style switch smoke; docs`.
