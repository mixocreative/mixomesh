// Viewport statistics (owner request 2026-10-21): selected / total objects plus
// triangles and vertices of the selection (or the scene when nothing is
// selected), with a short "before → after" highlight after a geometry change.
// Pure counting / formatting / diff logic; ui/StatsHud.js renders it.
//
// Cheap at 10M triangles: counts come from buffer LENGTHS (getTotalIndices /
// getTotalVertices — O(1)), never from scanning indices, and are cached per
// mesh against its GeometryStore revision + buffer sizes.

import { revisionOf } from '../geometry/GeometryStore.js';

/** How long a changed count shows "before → after". */
export const HIGHLIGHT_MS = 3000;

const _cache = new WeakMap();   // mesh → { rev, indices, vertices, tris, verts }

/**
 * Faces (triangles) + vertices of one mesh, from buffer lengths, cached per revision.
 * Unindexed meshes count vertices / 3 triangles.
 * @param {any} mesh  Babylon mesh (duck-typed: getTotalIndices / getTotalVertices)
 * @returns {{ tris: number, verts: number }}
 */
export function meshCounts(mesh) {
  if (!mesh || mesh.isDisposed?.() || !mesh.geometry) return { tris: 0, verts: 0 };
  const rev = revisionOf(mesh);
  const indices = mesh.getTotalIndices?.() ?? 0;
  const vertices = mesh.getTotalVertices?.() ?? 0;
  const hit = _cache.get(mesh);
  if (hit && hit.rev === rev && hit.indices === indices && hit.vertices === vertices) return hit;
  const entry = { rev, indices, vertices, tris: Math.floor((indices || vertices) / 3), verts: vertices };
  _cache.set(mesh, entry);
  return entry;
}

/** Sum counts over meshes (each mesh once). */
export function sumCounts(meshes) {
  let tris = 0, verts = 0;
  for (const m of new Set(meshes)) { const c = meshCounts(m); tris += c.tris; verts += c.verts; }
  return { tris, verts };
}

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
