# 和風 (Wafu) Playful UI + i18n — Design

Date: 2026-06-14
Status: approved (brainstorming)

## Goal

Make the overall UI more **playful** and 和風 (Japanese-style) while keeping the
precision-tool readability the app needs as a 3D-print workspace. Add real
**i18n** (English / 日本語 / 繁體中文) with browser detection, user override,
and `localStorage` persistence, with translations in separate JSON files so the
copy can be edited without touching code.

## Decisions (locked with user)

- **Scope:** new default — `wafu` replaces the current Blender-dark look.
  Safety git tag (`pre-wafu-2026-06-14`) committed before PR1 so the whole
  initiative can be reverted as one rollback anchor.
- **Surface:** **washi-light** (warm off-white paper) for panels AND viewport.
- **Accent:** dark-stone brown (quiet, wabi-sabi). Because brown-on-washi is
  low contrast, selection / active state gets a **secondary cue** —
  bengara red-orange tint on row backgrounds + outline R-channel.
- **Playfulness:** full — palette, type, texture, koi mascot, hanko toast,
  furigana on workspace tabs, optional sound (default off).
- **Viewport gradient:** warm washi vertical wash (sand top → paper bottom).
- **Heading typeface:** **Yuji Syuku** (sumi brush) on display targets only
  (panel titles, workspace tabs, modal headers). Body + inputs + viewport HUD
  stay system sans. Numerics stay mono. Yuji is dramatic — keeping it off
  inputs preserves the precision-tool legibility.
- **Mascot:** **koi fish**, idle in empty viewport corner, reacts to import +
  Ctrl-snap. Off if `state.ui.mascotEnabled = false` OR
  `prefers-reduced-motion`.
- **i18n:** EN / JA / zh-Hant. Browser-language detect on first boot
  (`navigator.languages` ordered scan), user can override from the Settings
  panel, choice persists in `localStorage` (`mx-locale-v1` — its own key,
  independent of `mx-settings-v1`).
- **Locale switcher** label always renders in its OWN script
  (`English / 日本語 / 繁體中文`) — universal i18n best practice; no flags.
- **Translation files** are separate JSON, flat-dotted keys, `{var}`
  interpolation, ICU-lite plural via `Intl.PluralRules`.
- **Delivery:** three PRs (i18n first — zero pixel change; then visual; then
  playful layer), each behind a git tag so rollback isolates blast radius.

## Architecture

### Three PRs, three tags

```
tag: pre-wafu-2026-06-14   ← safety anchor (no code change, just `git tag`)
├── PR1  feat(i18n): extract strings, add EN/JA/zh-Hant + switcher
│   tag: i18n-shipped
├── PR2  feat(theme): washi-light tokens + Yuji + viewport retune
│   tag: wafu-visual-shipped
└── PR3  feat(playful): koi + hanko + textures + sound + furigana
    tag: wafu-full-shipped
```

### Module boundaries

```
src/i18n/
  index.js              t(key, params), setLocale(code), getLocale(),
                        detectLocale(), applyHtmlLang(), SUPPORTED
                        + dispatches LOCALE_CHANGED event
  locales/en.json       flat-dotted keys, e.g. "panel.scene.title": "Scene"
  locales/ja.json
  locales/zh-Hant.json

src/ui/
  LocaleSwitcher.js     dropdown in header, three options in own-script
  Mascot.js             koi SVG, idle loop + import/snap reactions     (PR3)
  Hanko.js              stamp-drop toast wrapper, replaces Toast.js    (PR3)
  Sound.js              lazy WebAudio, plays on snap if enabled        (PR3)

src/styles/
  tokens.css            (existing path) — PR2 rewrites contents only
  blender.css           (existing) — RENAMED to wafu.css in PR2
                        (carries every selector forward; only tokens change)
  wafu.css              PR2 = renamed blender.css under new tokens.
                        PR3 APPENDS texture/pattern/koi/hanko layers to it.

src/config/
  default-settings.json adds:
                          "ui": {
                            "mascotEnabled": true,
                            "soundEnabled": false
                          }
                        Locale is NOT under `ui` — it has its own store
                        (`mx-locale-v1`); auto-detect on first boot.

public/
  textures/washi.svg          ~4 KB turbulence noise
  textures/asanoha.svg        ~2 KB hexagonal star tile
  textures/seigaiha.svg       ~2 KB wave tile
  koi.svg                     ~6 KB two-layer SVG (body + fin)
  sounds/tok.mp3              ~8 KB, lazy-loaded only when enabled
  fonts/YujiSyuku-Regular.woff2  self-hosted fallback for CSP-strict / offline

docs/
  TRANSLATIONS.md       how to edit / add / validate translations + new locale
```

### Boot order (in `src/app/boot.ts`)

1. `i18n.init()` — detect locale, load JSON, apply `<html lang>`, dispatch
   `LOCALE_CHANGED` once
2. (existing) scene / state / persistence init
3. `Mascot.init()` / `Hanko.init()` / `Sound.init()` — read `state.ui.*` flags
   and mount/wire lazily (PR3)

## PR1 — i18n (zero pixel change)

### Locale codes (BCP-47)

`en` · `ja` · `zh-Hant`

### Detection precedence

1. `localStorage.mx-locale-v1` (user choice always wins)
2. `navigator.languages` scanned in order; first match against `SUPPORTED`,
   with mapping: `zh-TW` / `zh-HK` / `zh-Hant*` → `zh-Hant`,
   `ja-*` → `ja`, `en-*` → `en`
3. `'en'` fallback

### File format — flat dotted key, ICU-lite `{var}`

```json
// src/i18n/locales/en.json
{
  "workspace.layout":   "Layout",
  "workspace.layout.sub": "配置",
  "toast.exported":     "Exported {filename}",
  "import.error.title": "Couldn't import {filename}",
  "_plural.objects":    "{n, plural, =0{No objects} one{1 object} other{# objects}}"
}
```

### API (`src/i18n/index.js`)

```js
t(key, params?)         // returns string; fallback chain: locale → en → key
setLocale(code)         // 'en' | 'ja' | 'zh-Hant'; persists, fires LOCALE_CHANGED
getLocale()             // current resolved code
detectLocale()          // applies precedence above
applyHtmlLang()         // sets <html lang="..."> for a11y / screen readers
SUPPORTED               // ['en','ja','zh-Hant']
```

### Pluralization

`Intl.PluralRules(locale)` + tiny `{n, plural, ...}` mini-parser (≤30 LOC).
Built-in browser API — zero dep. Don't pull `intl-messageformat` until plural
keys exceed ~20.

### Loading

All three locales imported at boot as JSON (`with { type: 'json' }`). Total
~30 KB combined. No async route-split — not worth the complexity for three
files this small.

### Persistence

OWN localStorage key `mx-locale-v1`:
```json
{ "v": 1, "locale": "ja" }
```
Locale is global, not panel state — different blast radius, different rollback.
`.mixo` files NEVER override locale (per-user preference, not project content).

### Re-render strategy

`LOCALE_CHANGED` event → every text-bearing panel re-runs its render. Existing
panels already re-render on state events — same hook, no new architecture.

Tagging convention: every translated DOM node carries `data-i18n-key="..."`
attribute so tests can assert by key, not by literal text.

### Translator-safety rules (enforced via ESLint custom rule or grep CI)

- Never concatenate keys: `t('a') + ' ' + t('b')` ❌ — one key per sentence.
- Always pass dynamic values as `params`, never interpolate first.
- `_`-prefixed keys are internal (plural / select), never surfaced raw.
- Always use `textContent` over `innerHTML` when inserting `t()` output.

### Switcher (`src/ui/LocaleSwitcher.js`)

Primary location: small `<select>` in the right side of the header (always
visible, fastest discovery). Options show each language in its own script:

```
English / 日本語 / 繁體中文
```

No flags — flags do not map to languages and break for `zh-Hant` (which flag?).

A secondary mirror lives in the new Settings → Appearance section (PR3) for
users who don't notice the header. Both call the same `setLocale()`; the
store has one source of truth.

### a11y

- `<html lang>` flips on `setLocale` so screen readers use correct phonemes.
- ARIA labels routed through `t()`.
- `prefers-reduced-motion` respected by PR3 animations (mascot / hanko).

## PR2 — Visual (washi + Yuji + stone accent)

### Token rewrite (`src/styles/tokens.css`)

```css
:root {
  /* Washi surfaces — warm off-white, slight cream undertone */
  --bg-0: #efe7d8;    /* deepest (header strip) */
  --bg-1: #f3ecdf;    /* outer panel */
  --bg-2: #f7f1e5;    /* inner panel / fields */
  --bg-3: #fbf6ec;    /* hover */
  --bg-4: #fffaf0;    /* lightest (lifted) */

  /* Sumi text — never pure black, slight warm */
  --text-0: #1a1612;
  --text-1: #4a3f33;
  --text-2: #7a6a58;

  /* Dark stone accent — quiet, wabi-sabi */
  --accent:    #3e2c1e;
  --accent-hi: #5c4633;
  --accent-fg: #fbf6ec;

  /* Secondary "active" cue — bengara red, ONLY for true active state */
  --active:    #a23a2a;
  --active-bg: rgba(162, 58, 42, 0.10);

  /* Hairlines = kasumi cloud — softer than 1px solid */
  --border:        #d4c9b3;
  --border-strong: #b8a98c;
  --border-focus:  var(--active);
  --ring-focus:    rgba(162, 58, 42, 0.28);

  /* Type — Yuji Syuku display, system body, mono numerics */
  --font-display: "Yuji Syuku", "Shippori Mincho", serif;
  --font-sans:    system-ui, -apple-system, "Segoe UI", "Hiragino Sans",
                  "Yu Gothic UI", "Noto Sans CJK TC", sans-serif;
  --font-mono:    ui-monospace, "SF Mono", Menlo, Consolas, monospace;

  /* Status — retuned for light bg readability */
  --danger:  #c0392b;
  --warning: #b8860b;
  --success: #2e7d32;
  --info:    #1e3a5f;
}
```

### Active-state contrast fix (mandatory — addresses the low-contrast risk)

- Selected row gets `background: var(--active-bg)` + left edge
  `box-shadow: inset 3px 0 0 var(--active)`.
- Selected mesh outline (existing two-channel mask in `SelectionOutline.js`):
  R-channel target color = `--active` (bengara), G-channel = `--accent` (stone).
- Toggle "on" state = stone border + active-bg tint.
- Focus ring stays `--ring-focus` (bengara alpha) — readable on washi.

### Typography rules

Display targets get `--font-display`:
- `.rp-section-header`, `.pp-section-header`, `.sp-section-header`
- workspace tab labels
- modal headers
- header brand wordmark

Body / inputs / viewport HUD: `--font-sans`. Numerics: `--font-mono`.

### Viewport gradient (`src/core/scene/SceneConstants.js`)

```
top    rgb(220, 208, 180)   sand
bottom rgb(245, 238, 220)   paper
```

### Light rig retune (`SceneManager.applyRenderSettings`)

Defaults in `default-settings.json` change:

| Field            | Old  | New  |
|------------------|------|------|
| `keyIntensity`   | 0.70 | 0.55 |
| `hemiIntensity`  | 0.85 | 0.55 |
| `exposure`       | 1.05 | 0.95 |
| `shadowDarkness` | 0.62 | 0.45 |

Tone map stays `aces`.

### `blender.css` rename → `wafu.css`

PR2 RENAMES `src/styles/blender.css` → `src/styles/wafu.css`. Every selector
inside is preserved verbatim (names like `.pp-toggle.pp-toggle-on` keep
working). Only the comment header changes — token rewrite happens in
`tokens.css`, not here, so the selectors automatically pick up the washi
palette. PR3 then APPENDS the texture / pattern / koi / hanko layers to
this same file.

### Font loading

`Yuji Syuku` from Google Fonts with `font-display: swap`, async stylesheet
load (`media="print" onload="this.media='all'"`). Self-hosted woff2 fallback
under `public/fonts/` for CSP-strict / offline. Metric twin
`Shippori Mincho` prevents layout shift if Yuji never arrives.

### `prefers-color-scheme: dark`

Ignored for now (washi IS the choice). Architecture lets a future
`tokens-dark.css` swap in via media query without rewriting selectors.

## PR3 — Playful (textures + koi + hanko + sound + furigana)

### `wafu.css` texture layer

| Layer | Implementation | Notes |
|---|---|---|
| Washi grain | `body { background-image: url("/textures/washi.svg"); }` | 4 KB SVG turbulence filter, repeats. |
| Kasumi divider | hairline + `mask-image: linear-gradient(...)` fade | Replaces flat 1px section dividers. |
| Asanoha toggle-on | SVG bg on `.pp-toggle-on::after`, opacity 0.12 | Hexagonal star pattern. |
| Seigaiha progress | `.progress-fill::before` wave tile, animated translate | Export / render progress. |

All texture SVGs ship under `public/textures/` (NOT base64 in CSS — base64
slows initial parse).

### Koi mascot (`src/ui/Mascot.js`)

- Inline SVG koi (single file `public/koi.svg`), ~6 KB, two layered paths
  (body + fin) for tail-wag.
- Mounts in viewport's lower-right corner when `state.scene.objects` is empty.
- Idle: 6s tail-wag loop via CSS `@keyframes` (transform-only, GPU-cheap).
- Reactions:
  - `OBJECTS_IMPORTED` → swim across once (8s translate), unmount.
  - `CURSOR_SNAP` → flash "splash" ring SVG, 400ms.
- Gates: `state.ui.mascotEnabled` AND `!prefers-reduced-motion`. Either off
  ⇒ no mount at all (don't render hidden).

### Hanko stamp toast (`src/ui/Hanko.js`)

Replaces existing toast wrapper. Same call sites, new look.

- Red square `#a23a2a`, rounded corners, white kanji label centred
  (`済` done, `失` failed, `保` saved). Kanji is decorative regardless of locale.
- Drop-in animation: `transform: scale(1.3) rotate(-4deg) → scale(1) rotate(0)`,
  120 ms, `cubic-bezier(0.34, 1.56, 0.64, 1)` (slight overshoot = stamp slap).
- Locale-aware message below kanji via `t()`.
- `prefers-reduced-motion` → straight fade-in instead of bounce.

### Sound (`src/ui/Sound.js`)

- ONE audio file `public/sounds/tok.mp3` (~8 KB), lazy-loaded only when
  `state.ui.soundEnabled = true` AND the first event fires.
- Plays on `CURSOR_SNAP` only. Not on every click.
- WebAudio API (not `<audio>`) for low-latency. Audio context not allocated
  until enabled.
- Default = OFF. Sound is opt-in, never opt-out.

### Furigana on workspace tabs

Each tab renders both a primary label and a subtitle (uses the i18n keys):

- locale=en: `Layout` (Yuji) / subtitle `配置` (small muted)
- locale=ja: `配置` / `Layout`
- locale=zh-Hant: `配置` / `Layout`

Translation file:
```json
{ "workspace.layout":     "Layout",
  "workspace.layout.sub": "配置" }
```
Hit-area unchanged.

### Settings UI (new "Appearance" section in the Scene panel)

- Locale switcher
- Mascot toggle
- Sound toggle
- Reset → factory in `default-settings.json`

## Data flow

- `LOCALE_CHANGED` → panels re-render labels. No state-model diff.
- `state.ui.*` flags live under SettingsStore `SCHEMA` as a new `ui` slice
  (same pattern as `gizmo` / `pivotMode`).
- Locale has its OWN store (`mx-locale-v1`) — separate from settings; `.mixo`
  files NEVER override locale.

## Error handling

| Failure | Behavior |
|---|---|
| `t('missing.key')` | Returns the key string + dev-only `console.warn`. Never throws. |
| Locale JSON corrupt | Fall back to `en`, log warn, don't block boot. |
| Yuji font fails | `font-display: swap` keeps system serif visible. Metric-compatible Shippori Mincho fallback prevents reflow. |
| Mascot SVG fails | Silent no-op (try/catch around mount). |
| Sound load fails | Log warn, disable runtime, don't bother user. |

## Security

- Translation files = static JSON, no `eval`, no template expressions.
- `t()` `{var}` interpolation produces plain strings; consumers MUST use
  `textContent`, not `innerHTML` (translator-safety rule).
- Self-hosted font fallback for CSP-strict mode.
- Audio file = same-origin only.

## Testing

| PR | Unit | Integration | Visual |
|---|---|---|---|
| PR1 i18n | `t()` fallback chain, plural arms, detect precedence, persist round-trip, missing-key warn | `LOCALE_CHANGED` re-renders header + one panel | `?locale=ja` boot → header reads JA |
| PR2 visual | tokens load, font fallback, viewport gradient values, active-cue applies on select | selected mesh outline uses bengara R-channel | screenshot empty + one panel, EN + JA + zh-Hant |
| PR3 playful | mascot mount/unmount on import event, hanko `prefers-reduced-motion` fallback, sound lazy-init | mascot disappears after import, hanko shows on toast | screenshot empty viewport with koi, hanko mid-drop |

Existing 78/78 headless pins need adaptation: assert by `data-i18n-key`, not
literal text.

### CI additions

- `npm run i18n:check` — every `t('key')` call in `src/` has matching entry in
  `en.json`. JA / zh-Hant may have empty values (warn, not fail) so
  translators can fill incrementally.
- Visual snapshot tolerance bumped slightly (texture noise = sub-pixel variance).

## Out of scope (will NOT ship in this initiative)

- Dark `sumi` variant of washi theme (architecture-ready, not built).
- Additional locales beyond EN / JA / zh-Hant.
- Simplified Chinese (`zh-Hans`) — add later once zh-Hant strings stabilize.
- Sound effects beyond Ctrl-snap `tok`.
- Mascot animations beyond idle + import-swim + snap-splash.
- Per-locale font swap (e.g. Noto Sans CJK TC for zh-Hant body) — system stack
  already covers via `Noto Sans CJK TC` fallback in `--font-sans`.

## Appendix A — Translation seed strings (v1)

These are the first-pass translations to ship in PR1. Anything missing falls
back to EN per the fallback chain. Translators iterate from here.

| key | en | ja | zh-Hant |
|---|---|---|---|
| `app.brand` | Mixomesh | Mixomesh | Mixomesh |
| `locale.en` | English | English | English |
| `locale.ja` | 日本語 | 日本語 | 日本語 |
| `locale.zh-Hant` | 繁體中文 | 繁體中文 | 繁體中文 |
| `workspace.layout` | Layout | レイアウト | 配置 |
| `workspace.layout.sub` | 配置 | Layout | Layout |
| `workspace.shade` | Shade | シェード | 著色 |
| `workspace.shade.sub` | 彩 | Shade | Shade |
| `workspace.scene` | Scene | シーン | 場景 |
| `workspace.scene.sub` | 場 | Scene | Scene |
| `workspace.print` | Print | プリント | 列印 |
| `workspace.print.sub` | 刷 | Print | Print |
| `panel.properties.title` | Properties | プロパティ | 屬性 |
| `panel.scene.title` | Scene | シーン | 場景 |
| `panel.print.title` | Print | プリント | 列印 |
| `panel.shader.title` | Shader | シェーダー | 著色器 |
| `panel.outliner.title` | Outliner | アウトライナ | 大綱 |
| `panel.assets.title` | Assets | アセット | 素材 |
| `panel.session.title` | Session | セッション | 工作集 |
| `panel.library.title` | Library | ライブラリ | 素材庫 |
| `section.transform` | Transform | トランスフォーム | 變換 |
| `section.shader` | Shader | シェーダー | 著色器 |
| `section.uv` | UV | UV | UV |
| `section.environment` | Environment | 環境 | 環境 |
| `section.camera` | Camera | カメラ | 攝影機 |
| `section.grid` | Grid | グリッド | 網格 |
| `section.rendering` | Rendering | レンダリング | 算繪 |
| `section.cross-section` | Cross Section | 断面 | 剖面 |
| `section.appearance` | Appearance | 外観 | 外觀 |
| `btn.reset` | Reset | リセット | 重設 |
| `btn.apply` | Apply | 適用 | 套用 |
| `btn.cancel` | Cancel | キャンセル | 取消 |
| `btn.ok` | OK | OK | 確定 |
| `btn.import` | Import | 読み込み | 匯入 |
| `btn.export` | Export | 書き出し | 匯出 |
| `btn.new` | New | 新規 | 新建 |
| `btn.save` | Save | 保存 | 儲存 |
| `btn.open` | Open | 開く | 開啟 |
| `btn.close` | Close | 閉じる | 關閉 |
| `setting.locale` | Language | 言語 | 語言 |
| `setting.mascot` | Mascot | マスコット | 吉祥物 |
| `setting.sound` | Sound | サウンド | 音效 |
| `toast.exported` | Exported {filename} | {filename} を書き出しました | 已匯出 {filename} |
| `toast.saved` | Saved | 保存しました | 已儲存 |
| `toast.reset` | Reset to defaults | 初期値に戻しました | 已重設為預設值 |
| `import.error.title` | Couldn't import {filename} | {filename} を読み込めませんでした | 無法匯入 {filename} |
| `empty.viewport` | Drop a file or import to start | ファイルをドロップまたは読み込み | 拖入檔案或匯入以開始 |
| `empty.session` | No assets in this session | このセッションに素材はありません | 此工作集中沒有素材 |
| `hanko.done` | done | 完了 | 完成 |
| `hanko.failed` | failed | 失敗 | 失敗 |
| `hanko.saved` | saved | 保存 | 已存 |
| `_plural.objects` | `{n, plural, =0{No objects} one{1 object} other{# objects}}` | `{n, plural, =0{オブジェクトなし} other{オブジェクト # 件}}` | `{n, plural, =0{無物件} other{# 個物件}}` |

> **Note on `zh-Hant` choices:** Taiwanese / Hong Kong tech vocabulary used:
> 算繪 (render), 著色 (shading), 匯入 / 匯出 (import / export), 列印 (print),
> 素材 (asset). zh-CN equivalents intentionally avoided — those land in a
> later `zh-Hans` file if/when added.

## Appendix B — How to edit translations

See `docs/TRANSLATIONS.md` — a translator-facing guide that covers file
locations, key naming, interpolation, plural syntax, validation commands,
and how to add a brand-new locale.

## Open questions

None — every decision locked above is sufficient to start writing the
implementation plan.
