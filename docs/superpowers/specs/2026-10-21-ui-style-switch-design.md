# UI Style Switch: Original / New (dense paper) — Design

Date: 2026-10-21 · Status: draft for owner approval

## Intent

The owner finds the sister project **mixosupports** (`S:\ai\mixosupports`, `src/styles.css`) looks
clearly better than MIXOMESH: one strict rule set — unbleached paper, warm grey ink, hairlines, one
red, flat, no shadows — against MIXOMESH's layered washi + Blender control language (5 near-identical
background steps, three competing accents, 51 `box-shadow`s). MIXOMESH also needs to be **compact**:
it should work on small screens (1366×768 laptops) and leave room for features still to come.

So MIXOMESH gains a second UI style, **New**, which is the mixosupports look at **Dense** density, and
a switch to choose between it and the current look, **Original**.

Density was chosen from a side-by-side mockup (`.superpowers/brainstorm/…/density.html`): the owner
picked **C — Dense (Blender-like)**: 22 px rows, 11.5 px base text, ~232 px side panels.

## Goals

1. A **New** style for MIXOMESH that adopts the mixosupports visual language:
   - palette (from `mixosupports/src/styles.css` `:root`):
     paper `#f4f2ed`, surface `#fbfaf7`, sunken `#ebe8e1`, line `#dcd7cd`, line-strong `#c4bdb0`,
     ink `#3b3631`, muted `#8a847a`, kraft `#b59f78`, red `#7f0019`, red-hover `#96102b`;
   - **one accent: the red.** It marks the primary action per view and the active/selected cue.
     Pressed/toggled buttons and checked controls use ink (`#3b3631` fill, paper text), as in
     mixosupports (`button.active`, `.check input { accent-color: ink }`);
   - **flat panels:** hairline borders and surface steps instead of shadows; radius 2 px everywhere;
   - focus = 1 px ink outline, offset 2 px; number fields = underline style (bottom hairline, red on
     focus) as in mixosupports `.number input`;
   - font: **Zen Kaku Gothic New** for UI text (ja/en), with zh-Hant using Taiwan glyph forms first
     (`'PingFang TC', 'Noto Sans TC', 'Microsoft JhengHei'`, then Zen Kaku), exactly as mixosupports
     does with `:root:lang(zh-Hant)`. Mono stays for numeric readouts.
2. **Dense** sizing in New: 22 px control/row height, 11.5 px base text (scale roughly 10.5 / 11 /
   11.5 / 13 / 15), tighter section and panel padding (≈8 px panel, ≈6 px between sections), default
   side panels ≈220 px (outliner) and ≈240 px (properties). The mockup's option C is the reference.
3. **Original** = MIXOMESH exactly as it is today. Not one pixel changes when Original is selected.
4. A **style switch** in the header, next to the language picker (`src/ui/LocaleSwitcher.js`,
   mounted from `src/ui/AppShell.js`), with labels translated in en / ja / zh-Hant like every other
   UI string (`npm run i18n:check` must pass).
5. **Default: New.** A first-time user (no saved choice) gets New. The choice is remembered across
   sessions and restarts (web and Electron), the same way the locale is (`mx-locale-v1` pattern in
   `src/i18n/index.js`: versioned JSON in `localStorage`, guarded with try/catch).
6. Switching applies **instantly**, no reload, no lost work.

## Non-goals

- **mixosupports does not change.** It is a demo page for one function and stays as it is.
- No layout restructuring: same panels, same order, same controls, same workspaces. Only appearance
  and sizing differ.
- No dark theme.
- No behaviour, geometry, memory, or slicing changes. This is CSS + a small switch.

## Anti-goals (failure even if it "works")

- The 3D viewport's **chromed-glass material stays** in both styles (owner decision):
  `.viewport-toolbar`, `.vp-toggles`, `.nav-cube`, `.n-panel` keep their `--hud-*` tint, sheen,
  noise, border and shadows. New must not flatten them. **Everything else on the HUD unifies with
  New** (owner: "unify all"): Zen Kaku font, Dense sizes, 2 px radius, ink/red "on" states via the
  remapped `--active`/`--active-bg` — so the root-scoped token override is allowed to flow into the
  HUD; only the glass tokens are left alone.
- Original drifting: any visual change to Original is a bug.
- New becoming a third half-style: if a component still shows washi brown, bengara, or a drop shadow
  outside the HUD while New is active, it is unfinished.
- Text clipping or overflow at Dense size in ja / zh-Hant (longer labels) or at 1366×768 / 1024×768.
- Existing tests broken.

## Constraints

- MIXOMESH CSS is mostly tokenised: ~1,800 `var(--…)` uses vs ~40 literal hex colours across
  `src/styles/**` (18 stylesheets linked from `index.html`, `blender.css` loaded last to win the
  cascade, `responsive.css` and `viewer.css` after it). The intended mechanism is therefore a
  **token override scoped to the root**, e.g. `:root[data-ui-style="new"] { … }`, plus targeted rules
  for the literal colours, shadows, and Blender-pill controls that tokens don't reach.
- Shadows today come from `--shadow-md`, `--shadow-lg`, `--sheet-shadow`, focus rings
  (`--ring-focus`), and the HUD set. In New: panel/modal/popover/sheet shadows go to none and those
  surfaces get a 1 px line border instead; HUD shadows untouched.
- `--ctl-h` is already 22 px; Dense is mainly about type scale, padding, row gaps, and panel widths.
  Panel widths are CSS variables (`--outliner-width`, `--right-panel-width`, see
  `src/styles/layout.css`) and are user-resizable; New only changes the defaults.
- **Fonts must be bundled locally.** MIXOMESH runs offline (PWA `public/sw.js`) and in Electron, so
  no Google Fonts request. Zen Kaku Gothic New is SIL OFL 1.1 — ship it under `public/` (woff2) with
  its licence file, and add it to the service-worker cache. Japanese fonts are large; load only the
  weights used (400, 500) and prefer subset/unicode-range files.
- The style attribute must be set **before first paint** (in the boot path that sets `<html lang>`,
  or an inline snippet in `index.html`) so New users never see an Original flash.
- Existing suites keep passing: `npm test`, `npm run lint`, `npm run typecheck`, `npm run i18n:check`,
  `npm run test:browser` and the other browser smokes. `tests/browser-smoke.mjs` reads computed
  styles in places (display checks) — those must hold in both styles.
- Babylon-side colours (selection outline `--accent-vibrant` wheat glow, axis colours, gizmo) are
  viewport content, not chrome; they stay unchanged in both styles.

## Decided by the owner

- New = mixosupports style at Dense density (mockup option C).
- Switch between Original and New; Original stays as today.
- Chromed-glass viewport HUD material remains in New; its font, sizing and states unify with New.
- One font everywhere in New: Zen Kaku Gothic New (zh-Hant: Taiwan-form fallback first), chosen
  over system UI from a side-by-side mockup. Small labels may use weight 500 where 400 reads thin.
- Default for first-time users: New.
- mixosupports itself unchanged.

## Calls made by Claude (owner may override)

- Switch placement: header, beside the language picker; a two-option control styled like the
  locale `<select>` (or a two-segment toggle) — builder's choice of control, same location.
- Persistence key in the locale pattern, e.g. `mx-ui-style-v1` → `{ v: 1, style: 'new' | 'original' }`.
- **Red vs ink, copied from mixosupports:** tabs, segmented buttons, pressed toggles, checked
  controls, expanded menu items → **ink** fill with paper text (`.ws-btn.active`, `.pp-tab.active`,
  `.pp-seg-btn[aria-checked]`, `.cm-item[aria-expanded]`, viewer-menu active item). Selected rows
  (`.ol-selected`) → **sunken** background, no colour. **Red** only for: the one primary action per
  view, progress fill, number-field focus underline, and the single current-item marker
  (`.ol-active` edge/badge, like mixosupports' active unit badge).
- **Status colours stay** (mixosupports keeps its own: island `#b3261e`, overhang `#d97706`), but
  muted to sit on paper: danger `#b3261e`, warning `#b07a12`, success `#4a6b3a`, info `#3b4a5c`,
  used as text/icon colour with faint same-hue tints for banners. Destructive buttons use danger
  outline/text, never the brand-red fill, so they don't read as the primary action.
- **Original's only change** is the new switch in its header. Acceptance compares Original
  screenshots to `main` with the switch's box masked; everything else must be pixel-identical.
  In Original the switch reuses the locale `<select>` styling so it looks native there.
- Display font (`--font-display`, Yuji Syuku for brand moments) stays as is in both styles.

## Left to the builder

- Exact mapping of MIXOMESH's 5-step `--bg-0..4` ramp onto paper / surface / sunken (aim: three
  visible steps; `--bg-3/4` may collapse onto surface / white).
- Which `blender.css` pill rules need New-scoped overrides vs. which follow from tokens alone.
- Exact Dense spacing values per component, judged against the option C mockup and the screenshot
  tool (`scripts/ui-screenshot.mjs`, `SIZES="1366x1024,1024x768,390x844"`) in both styles and all
  three locales.
- Whether the attribute lives on `<html>` or `<body>`, and how `responsive.css` breakpoints interact
  with Dense (phone layout should still work).
- Test additions: at minimum, a browser smoke that toggles the style, asserts the attribute and
  persisted value, reloads, and asserts New is restored; and that a fresh profile boots in New.

## Done when

- Fresh profile opens in New; switching to Original and back is instant and survives restart.
- Screenshots of all workspaces at the three SIZES, in en / ja / zh-Hant, show New with no washi
  brown, bengara, or non-HUD shadows, nothing clipped; Original screenshots are pixel-identical to
  `main` before the change, apart from the masked switch box.
- All existing suites green; new style-switch smoke green.
