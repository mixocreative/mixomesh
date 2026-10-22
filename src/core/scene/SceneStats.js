// Viewport statistics (owner request 2026-10-21): selected / total objects plus
// triangles and vertices of the selection (or the scene when nothing is
// selected), with a short "before → after" highlight after a geometry change.
// Pure formatting / diff logic; ui/StatsHud.js renders it. The counts come
// from core/scene/TriangleCount (the one counter).

/** How long a changed count shows "before → after". */
export const HIGHLIGHT_MS = 3000;

/** Locale-aware integer formatting (en: 1,234,567 · ja / zh-Hant: 1,234,567). */
export function formatCount(n, locale = 'en') {
  try { return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number.isFinite(n) ? n : 0); }
  catch { return String(Math.round(Number.isFinite(n) ? n : 0)); }
}

/**
 * Before/after highlight state machine. Snapshots carry `kind` ('selection' |
 * 'scene') and `key` (the selection identity). A geometry change that alters
 * the counts within the same kind starts (or extends) a HIGHLIGHT_MS window —
 * that covers Subdivide on the selection, and a Boolean whose result replaces
 * the selected operands. A selection-only change ends any highlight; a change
 * of kind (e.g. Delete clears the selection) never highlights.
 * Chained operations inside the window keep the ORIGINAL before value.
 * @param {{ kind: string, key: string, tris: number, verts: number } | null} prev
 * @param {{ kind: string, key: string, tris: number, verts: number }} next
 * @param {{ from: { tris: number, verts: number }, until: number } | null} current
 * @param {number} now
 * @param {boolean} geometryChanged  this recompute came from a geometry event
 */
export function nextHighlight(prev, next, current, now, geometryChanged) {
  if (!prev) return null;
  const active = current && current.until > now ? current : null;
  if (geometryChanged && prev.kind === next.kind && (prev.tris !== next.tris || prev.verts !== next.verts)) {
    return { from: active ? active.from : { tris: prev.tris, verts: prev.verts }, until: now + HIGHLIGHT_MS };
  }
  if (prev.key !== next.key || prev.kind !== next.kind) return null;
  return active;
}

/**
 * Text parts for the HUD.
 * @param {{ selected: number, total: number, tris: number, verts: number,
 *           highlight?: { from: { tris: number, verts: number }, until: number } | null,
 *           now?: number, locale?: string, t: (key: string, params?: object) => string }} m
 * @returns {{ scope: string, triangles: string, vertices: string, changed: { tris: boolean, verts: boolean }, label: string }}
 */
export function statsView({ selected, total, tris, verts, highlight = null, now = 0, locale = 'en', t }) {
  const f = (n) => formatCount(n, locale);
  const live = highlight && highlight.until > now ? highlight.from : null;
  const changed = { tris: !!live && live.tris !== tris, verts: !!live && live.verts !== verts };
  const arrow = (from, to, on) => (on ? `${f(from)} → ${f(to)}` : f(to));
  const scope = selected > 0
    ? t('stats.selected', { n: f(selected), total: f(total) })
    : t('stats.scene', { total: f(total) });
  // Owner wording: "Faces" (every mesh is triangulated, so faces = triangles);
  // the accessible label spells out "Faces (triangles)".
  const triangles = `${t('stats.faces')} ${arrow(live?.tris, tris, changed.tris)}`;
  const vertices = `${t('stats.vertices')} ${arrow(live?.verts, verts, changed.verts)}`;
  const longFaces = `${t('stats.facesLong')} ${arrow(live?.tris, tris, changed.tris)}`;
  return { scope, triangles, vertices, changed, label: `${scope} · ${triangles} · ${vertices}`, ariaLabel: `${scope} · ${longFaces} · ${vertices}` };
}
