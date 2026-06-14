export const ACCENT_HEX = '#f59e0b';
// Dark stone variant for selection outline + 3D cursor when the viewport bg
// is LIGHT (warm amber-on-light reads as washed-out). Auto-flipped by
// SceneManager.applyRenderSettings based on render.background.
export const OUTLINE_ACTIVE_LIGHT_HEX   = '#5c1f08';   // deep burnt amber
export const OUTLINE_SELECTED_LIGHT_HEX = '#8a3c0a';   // medium amber-brown
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
export const BG_DARK_TOP = '#3c4046';
export const BG_DARK_BOTTOM = '#1e2126';
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
// Two-tone selection outline: the ACTIVE object gets a deeper/darker orange so
// it reads apart from the other (accent-amber) selected objects.
export const OUTLINE_ACTIVE_HEX   = '#c2410c';   // orange-700 (darker)
export const OUTLINE_SELECTED_HEX = ACCENT_HEX;  // amber accent
