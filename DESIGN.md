# Design System: MIXOMESH Washi Workbench

Design reference for MIXOMESH UI mockups (Stitch, overhaul plan "Mockup gate" tasks).
Source of truth for values is the code: `src/styles/tokens.css` (tokens) and
`src/styles/blender.css` (control language, loaded last). If this file and the CSS
disagree, the CSS wins and this file is corrected. Stitch output is a reference
picture only — never paste generated HTML/CSS into `src/`.

## 0. Two interface styles (2026-10-21)

MIXOMESH ships two styles, switched in the header next to the language picker
(`src/ui/UiStyleSwitcher.js`, stored as `mx-ui-style-v1`):

- **New** (default): the shared Mixo app style, Dense. Values come from the
  `mixo-app-style` skill (github.com/mixocreative/mixo-app-style) and live in
  `src/styles/style-new.css`, every rule scoped to
  `:root:not([data-ui-style="original"])` (`tests/style-new-scope.test.mjs`).
  Dense panel widths: `workspaceDefaults()` in `src/ui/Workspace.js`.
- **Original**: the washi workbench described in the rest of this file,
  unchanged.

Change New's values in the skill first, then mirror them here.

## 1. Visual Theme & Atmosphere

**Direction (owner, 2026-10-14): minimal, clean, modern.** A calm, light
3D-print workbench: flat surfaces, generous whitespace, hairlines instead of
boxes, one accent, restrained colour, clear type hierarchy, no ornament. The
locked palette stays (warm washi off-white ground, sumi-ink text, a single dark
stone-brown accent, bengara red ONLY for the active/selected cue) but is used
quietly: mostly neutral surfaces, the accent reserved for the one primary
action per view. Density stays desktop-tool compact (22px controls, 12–13px
type) yet airy: group with spacing and subtle surface steps, not borders.
The 3D viewport is the hero and fills the centre; panels frame it and stay
visually quieter than the model. Mood words: minimal, modern, clean, calm,
precise, beginner-friendly, premium tool (Figma / Linear / Bambu Studio level
polish). Avoid: gradients on chrome (except the viewport HUD glass), heavy
shadows, floating SaaS cards, badge dots, icon clutter, all-caps headings,
multiple competing accents.

## 2. Color Palette & Roles

### Primary Foundation
- **Washi Ground (`#efe7d8`)**: app background, segmented-control trough (`--bg-0`).
- **Washi Panel (`#f3ecdf`)**: top-level panel bars (`--bg-1`).
- **Washi Sheet (`#f7f1e5` → `#fbf6ec` → `#fffaf0`)**: layered panel bodies, raised rows, popovers (`--bg-2..4`).
- **Kasumi Hairline (`#d4c9b3`)**: default 1px borders; **Strong Hairline (`#b8a98c`)** for emphasis; **Section Rule (`#c9bda2`)** between sections.

### Accent & Interactive
- **Stone Brown (`#3e2c1e`)**: THE accent — primary buttons, checkbox/range accent, disclosure triangles (`--accent`); hover **Lifted Stone (`#5c4633`)**; text on it **Paper (`#fbf6ec`)**.
- **Bengara Red (`#a23a2a`)**: active/selected cue only — selected row left edge, focused field border, active state; paired with **Bengara Wash (`rgba(162,58,42,0.10)`)** background tint and a 28% focus ring.
- **Wheat Glow (`#e4c094`)**: viewport selection silhouette only (`--accent-vibrant`).
- Blender's blue is NOT used. Amber is retired.

### Typography & Text Hierarchy
- **Sumi Ink (`#1a1612`)**: primary text.
- **Sepia Ink (`#4a3f33`)**: section headers, secondary labels.
- **Faded Ink (`#7a6a58`)**: captions, sub-group labels, hints.
- **Ghost Ink (`#a99e8c`)**: disabled.

### Functional States
- **Danger (`#c0392b`)**, **Warning (`#b8860b`)**, **Success (`#2e7d32`)**, **Info (`#1e3a5f`)** — text/icon colour on washi; use a faint tint of the same hue for banners, never saturated fills.
- Axis colours (CAD convention): **X `#e0584f`**, **Y `#6fb04a`**, **Z `#4a86d6`**.
- Viewport HUD (toolbar, toggles, nav cube, N-panel): fake "chromed glass" — translucent `rgba(245,247,252,0.38)` tint + white top sheen + 1px `rgba(255,255,255,0.45)` edge + soft drop shadow; text `#1a1d24`. Only HUD overlays on the 3D canvas use this.

## 3. Typography Rules

- **Sans (UI)**: `system-ui, -apple-system, "Segoe UI", "Hiragino Sans", "Yu Gothic UI", "Noto Sans CJK TC", sans-serif` — all UI text; CJK-safe (en / ja / zh-Hant locales).
- **Display (logo / brand moments only)**: `"Yuji Syuku", "Shippori Mincho", serif` — calligraphic; never for UI labels.
- **Mono**: `ui-monospace, "SF Mono", Menlo, Consolas, monospace` — numeric readouts (mm, tris, ratios, file names).
- Scale: `11px` (xs: sub-group labels, uppercase `0.06em` tracking, 600) · `12px` (sm: section headers sentence case 600, row labels) · `13px` (md: body, base line-height 1.5) · `15px` (lg: modal titles) · `18px` (xl: rare headings).
- Section headers are sentence case, no letter-spacing. Only tier-3 sub-group labels are uppercase.

## 4. Component Stylings

- **Field (input/select)**: `22px` min height, fill `#fbf6ec`, 1px `#c9bda2` border, `4px` radius, padding `1px 6px`; hover lightens to `#fffaf0`; focus border Bengara + ring; disabled = panel colour, no border.
- **Button**: filled not outlined — same fill/border as fields; hover lightens, press darkens to `#e9dfc8` (Blender push feel). **Primary**: Stone Brown fill, Paper text. Danger buttons are text-red, never a red fill.
- **Property row**: two-column grid, label column `84px` RIGHT-aligned against its value (Blender signature); XYZ rows = label + 3 equal fields with axis-coloured chips.
- **Section (3 tiers)**: tier 1 panel bar (filled `#f3ecdf`); tier 2 collapsible section header with stone-brown disclosure triangle, body indented `6px` with a 1px guide rail; tier 3 uppercase sub-group label with hairline above.
- **Tabs**: segmented control — Washi Ground trough, `2px` padding, active segment raised to field fill + 600 weight. No underline tabs.
- **Toggles**: a feature/mode/visibility switch is a toggle button (pressed = Bengara wash); a sub-option is a checkbox.
- **Outliner row**: 22–24px rows, indent per hierarchy level, selected = Bengara left edge + wash, hover = `#fbf6ec`; trailing pills for status.
- **Modal**: Washi Sheet `#fbf6ec`, `8px` radius, shadow `0 12px 32px rgba(62,44,30,0.28)`, title 15px, primary action right.
- **Domain — Print readiness strip**: one row, status word + icon in functional colour (Ready / Needs repair / Too big), monospace size readout.
- **Domain — Viewport toolbar**: vertical chromed-glass pill on the canvas edge, 28px icon buttons, active tool = Bengara wash.

## 5. Layout Principles

- Desktop app shell, design canvas `1280×800` minimum (works to 1920+). CSS grid: rows `40px` top bar · `1fr` workspace · asset panel (default `220px`, resizable) · `28px` status bar; columns Outliner (default `260px`) · viewport `1fr` · right panel (default `300px`, 240–360px).
- Four workspaces (Layout / Shade / Scene / Print), each = Properties + at most one specialist section; no section appears twice.
- Spacing scale (px): 2 · 4 · 6 · 8 · 12 · 16 · 24 (base 4px; 8px rhythm between rows, 12px between sections).
- Radii: 4px controls, 6px groups/segmented trough, 8px modals/cards.
- Motion: `120ms` / `200ms`, `cubic-bezier(0.4,0,0.2,1)`; no bouncy UI motion.
- Below 900px width the side panels collapse (not a mobile-first app).

## 6. Design System Notes for Stitch Generation

- Atmosphere: "minimal, clean, modern 3D-print desktop tool; flat warm off-white surfaces, generous whitespace, hairline dividers instead of boxes, compact 22px controls, sumi-ink text, ONE dark stone-brown accent for the primary action, bengara red only for the active/selected cue; Figma/Linear-level polish".
- Canonical colours: Washi Ground `#efe7d8`, Washi Sheet `#fbf6ec`, Sumi Ink `#1a1612`, Sepia Ink `#4a3f33`, Stone Brown `#3e2c1e`, Bengara Red `#a23a2a`, Kasumi Hairline `#d4c9b3`.
- Leave the centre viewport as a plain light-grey gradient placeholder (`#e8e6e1` → `#cfcbc3`) labelled "3D viewport"; mock only the panel chrome around it.
- Prompt 1: "Right-side Properties panel, 300px wide, collapsible sections with right-aligned 84px labels, 22px cream fields, XYZ rows with red/green/blue axis chips, one stone-brown primary button."
- Prompt 2: "Print workspace export panel: segmented tabs (Printer / Export / Check), a one-row readiness strip saying 'Ready' in green with a tick, printer select, 'Print at: the size shown' select, primary 'Export…' button."
- Prompt 3: "Left Outliner tree, 260px, groups and objects with chevrons, selected row with a bengara-red left edge and faint red wash, small status pills at the row end."
