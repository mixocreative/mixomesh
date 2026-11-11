// `object.supports` in a .mixo (project 3.6, plan 2026-10-29 P4.1). The record lives on the
// logical-object lead (src/supports/model.ts) and is plain JSON already (D19): saved as a deep
// copy, restored through a shape check so a damaged record is dropped, never half-applied. The
// runtime caches (support mesh, automatic placement) are not saved; they are rebuilt lazily.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrArr = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const isVec = (v, n) => Array.isArray(v) && v.length === n && v.every(Number.isFinite);
const isPoint = (p) => isObj(p) && typeof p.id === 'string' && isVec(p.position, 3);

function validPose(pose) {
  return pose === null || (isObj(pose) && isVec(pose.rotation, 4) && isVec(pose.scale, 3));
}

/** Whether a parsed `supports` value has the shape of model.ts `ObjectSupports`. */
export function isSupportsRecord(s) {
  if (!isObj(s) || !isObj(s.settings) || typeof s.settings.preset !== 'string') return false;
  if (!isStrArr(s.deleted) || !Array.isArray(s.manual) || !s.manual.every(isPoint)) return false;
  if (!isObj(s.overrides)) return false;
  if (!isObj(s.stamps) || typeof s.stamps.kinds !== 'string') return false;
  const d = s.stamps.data;
  if (!(typeof d === 'string' || (Array.isArray(d) && d.every(Number.isFinite)))) return false;
  if (!(s.sourceHash === null || typeof s.sourceHash === 'string')) return false;
  if (!validPose(s.pose)) return false;
  if (!(s.placed === null || isObj(s.placed))) return false;
  return Number.isFinite(s.revision);
}

/** A deep copy of the object's supports for the document, or undefined when it has none. */
export function serialiseSupports(object) {
  const s = object?.supports;
  return isSupportsRecord(s) ? JSON.parse(JSON.stringify(s)) : undefined;
}

/**
 * The supports of a saved scene object, with the reason when there are none.
 *
 * MX-03: a damaged record is still dropped — half-applying one is worse — but
 * the drop is REPORTED, not swallowed. What it costs the user is hand work
 * (manual points, deleted contacts, overrides, stamps) that cannot be
 * recomputed, so the loader must be able to say whose work it lost instead of
 * ending on a green "Loaded". `dropped` is the object's name, or null when
 * there was simply nothing to restore (older files have no record at all).
 *
 * @param {{supports?: unknown, name?: string, id?: string}|null|undefined} saved
 * @returns {{supports: object|undefined, dropped: string|null}}
 */
export function restoreSupports(saved) {
  const s = saved?.supports;
  if (s === undefined || s === null) return { supports: undefined, dropped: null };
  if (!isSupportsRecord(s)) return { supports: undefined, dropped: saved?.name ?? saved?.id ?? 'unnamed object' };
  return { supports: JSON.parse(JSON.stringify(s)), dropped: null };
}
