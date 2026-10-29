// Pure maths of the numeric Transform sheet (overhaul 8.5); no scene or DOM imports.
// All values are relative and applied about the active pivot, the same pivot the
// gizmo and the G/R/S modal use:
//   Move X/Y/Z mm, Rotate X/Y/Z deg (world axes, X then Y then Z), Scale % (uniform, 100 = unchanged).
// Defaults (0 / 0 / 100) mean "no change".

import { BU_TO_MM } from '../../core/print/ExportContext.js';

export const SCALE_PERCENT_MIN = 0.01;
export const SCALE_PERCENT_MAX = 100000;

export interface SheetValues {
  moveX: number; moveY: number; moveZ: number;
  rotX: number; rotY: number; rotZ: number;
  scalePct: number;
}
export const SHEET_DEFAULTS: Readonly<SheetValues> = Object.freeze({
  moveX: 0, moveY: 0, moveZ: 0, rotX: 0, rotY: 0, rotZ: 0, scalePct: 100,
});

interface Vec { x: number; y: number; z: number }
interface Quat extends Vec { w: number }
export interface NodeSnap { position: Vec; rotation: Quat; scaling: Vec }

export function isNoopValues(v: SheetValues): boolean {
  return v.moveX === 0 && v.moveY === 0 && v.moveZ === 0 &&
         v.rotX === 0 && v.rotY === 0 && v.rotZ === 0 && v.scalePct === 100;
}

/** prev/next absolute snapshots for the sheet values. */
export function planSheetTransform(
  entries: { id: string; snap: NodeSnap }[],
  pivot: Vec,
  values: SheetValues,
  buToMm: number = BU_TO_MM,
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const B = (window as any).BABYLON;
  const noop = isNoopValues(values);
  const prev: Record<string, NodeSnap> = {};
  const next: Record<string, NodeSnap> = {};
  const d = new B.Vector3(values.moveX / buToMm, values.moveY / buToMm, values.moveZ / buToMm);
  const rad = Math.PI / 180;
  // World-axis order X, then Y, then Z: q = qz * qy * qx.
  const qx = B.Quaternion.RotationAxis(B.Axis.X, values.rotX * rad);
  const qy = B.Quaternion.RotationAxis(B.Axis.Y, values.rotY * rad);
  const qz = B.Quaternion.RotationAxis(B.Axis.Z, values.rotZ * rad);
  const q = qz.multiply(qy).multiply(qx);
  const s = values.scalePct / 100;
  const pv = new B.Vector3(pivot.x, pivot.y, pivot.z);

  for (const { id, snap } of entries) {
    prev[id] = snap;
    const rel = new B.Vector3(snap.position.x, snap.position.y, snap.position.z).subtract(pv);
    const rotated = rel.applyRotationQuaternion(q);
    const pos = pv.add(rotated.scale(s)).add(d);
    const rot = q.multiply(new B.Quaternion(snap.rotation.x, snap.rotation.y, snap.rotation.z, snap.rotation.w));
    rot.normalize();
    next[id] = {
      position: { x: pos.x, y: pos.y, z: pos.z },
      rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w },
      scaling: { x: snap.scaling.x * s, y: snap.scaling.y * s, z: snap.scaling.z * s },
    };
  }
  return { prev, next, noop };
}
