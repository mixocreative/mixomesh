// ── JS-side colour constants ────────────────────────────────────────────
// Babylon-runtime colours used by the 3D scene (gradient bg, outline shader,
// 3D cursor). CSS-side tokens for UI panels + HUD live in src/styles/tokens.css.
//
// Overlap with CSS:
//   ACCENT_HEX (here, amber) ≠ CSS --accent (stone brown).
//   The viewport selection theme stays amber on dark bg by design; the panel
//   accent is stone-brown for the wafu palette. Intentional divergence.
//   The X/Y/Z axis hexes used here (CAD convention) pair with CSS
//   --axis-x / --axis-y / --axis-z in tokens.css — keep both in sync by hand.
//
// Pure JS constants only; do NOT import anything from src/styles/.

export const ACCENT_HEX = '#f59e0b';
// Dark stone variant for selection outline + 3D cursor when the viewport bg
// is LIGHT (warm amber-on-light reads as washed-out). Auto-flipped by
// SceneManager.applyRenderSettings based on render.background.
// Yellowish-orange on the (default) light/cream bg — saturated enough to read
// against cream; ACTIVE brighter than the deeper SELECTED.
export const OUTLINE_ACTIVE_LIGHT_HEX   = '#f97316';   // vivid orange (active, brighter)
export const OUTLINE_SELECTED_LIGHT_HEX = '#c2410c';   // deeper orange-700 (selected)
export const CURSOR_LIGHT_HEX           = '#5c1f08';

export const DEFAULT_GRID_CELL_MM = 10;
export const DEFAULT_GRID_SUBDIV = 10;
export const MM_PER_BU = 1000;
export const AXES_SIZE = 0.05;
export const CAM_RADIUS_MIN = 0.02;
export const CAM_RADIUS_MAX = 5;
export const CURSOR_DIAMETER = 0.003;
// 3D-cursor ring/crosshair tint — the app accent amber (matches selection theme).
export const CURSOR_HEX = '#f59e0b';

export const BG_GRADIENT_TOP = '#fcf9f3';
export const BG_GRADIENT_BOTTOM = '#f3ecdf';
// Dark viewport variant (Scene ▸ Render background toggle) — Blender-ish
// neutral grays, kept lighter than the UI panels so silhouettes still read.
export const BG_DARK_TOP = '#46433c';
export const BG_DARK_BOTTOM = '#26241e';
export const HEMI_INTENSITY = 0.85;
export const HEMI_GROUND_COLOR = '#c6cbd2';
export const KEY_INTENSITY = 0.70;
export const FILL_INTENSITY = 0.25;
export const SHADOW_DARKNESS = 0.62;
export const SHADOW_BLUR_KERNEL = 32;
export const TONE_CONTRAST = 1.10;
export const TONE_EXPOSURE = 1.05;

export const REVERT_DELTA_SQ = 1e-6;
export const REVERT_ANGLE_DELTA = 0.005;
export const OUTLINE_RADIUS_PX = 4.5;
export const OUTLINE_INTENSITY = 2.0;
export const MASK_BRIGHTNESS_ACTIVE = 1.0;
export const MASK_BRIGHTNESS_SELECTED = 0.5;
// Two-tone selection outline (yellowish-orange family): the ACTIVE object gets
// a BRIGHTER yellow-orange so it reads apart from the other (amber) selected
// objects. (Dark-bg variants; light-bg pair above.)
export const OUTLINE_ACTIVE_HEX   = '#fcc419';   // bright yellow-orange (active)
export const OUTLINE_SELECTED_HEX = ACCENT_HEX;  // amber accent (selected, dimmer)
