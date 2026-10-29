import { PROGRESS_STAGE } from '../core/progress';
import type { ProgressCallback, TriangleMesh } from '../core/analysis/types';
import type { PrintScene, PrintUnit } from '../state/projectTypes';
import { transformPoint, type ModelTransform } from '../state/transform';
import { unitContacts, type BuiltSupports } from './unitSupports';

/**
 * What an export writes: printable (model plus supports) or supports only; `active-*` one file of
 * the active unit, `separate-*` one file per unit, `whole-printable` one file for the plate.
 */
export type ExportKind =
  | 'active-printable'
  | 'active-supports'
  | 'separate-printable'
  | 'separate-supports'
  | 'whole-printable';

/** One mesh of an export file: the unit's model or its supports, placed by the unit transform. */
export interface ExportPartPlan {
  unitId: string;
  content: 'model' | 'supports';
}

/** One STL file of an export: its unique file name and the meshes it holds. */
export interface ExportFilePlan {
  fileName: string;
  parts: ExportPartPlan[];
}

/** A part ready to encode: unit-local mesh plus the transform to plate space (y = 0 is the plate). */
export interface ExportPart {
  mesh: TriangleMesh;
  transform: ModelTransform;
}

/** The units (with their scene index) an export of this kind includes. */
export function exportUnits(scene: PrintScene, kind: ExportKind): [PrintUnit, number][] {
  const indexed = scene.units.map((unit, index) => [unit, index] as [PrintUnit, number]);
  if (kind.startsWith('active')) return indexed.filter(([unit]) => unit.id === scene.activeUnitId);
  return indexed;
}

/**
 * Files of an export: one per unit for the separate modes, otherwise one for the plate. A unit
 * without a live contact (all deleted or zoned out, as its latest build in `built` left them) has
 * no supports part, so no file is empty.
 */
export function planExport(scene: PrintScene, kind: ExportKind, built: ReadonlyMap<string, BuiltSupports>): ExportFilePlan[] {
  const supportsOnly = kind.endsWith('supports');
  const suffix = supportsOnly ? 'supports' : 'printable';
  const partsOf = (unit: PrintUnit): ExportPartPlan[] => [
    ...(supportsOnly ? [] : [{ unitId: unit.id, content: 'model' as const }]),
    ...(unit.supports && unitContacts(unit, built.get(unit.id)).length > 0 ? [{ unitId: unit.id, content: 'supports' as const }] : []),
  ];
  const units = exportUnits(scene, kind).map(([unit]) => unit);
  if (kind === 'whole-printable') {
    const parts = units.flatMap(partsOf);
    return parts.length === 0 ? [] : [{ fileName: `scene-${suffix}.stl`, parts }];
  }
  const files = units.map((unit) => ({ name: `${unit.name}-${suffix}`, parts: partsOf(unit) })).filter((file) => file.parts.length > 0);
  const names = uniqueFileNames(files.map((file) => file.name));
  return files.map((file, index) => ({ fileName: names[index]!, parts: file.parts }));
}

/**
 * Binary STL of the parts in plate space, written Z-up: STL (x, y, z) = web (x, -z, y).
 * Empty meshes are skipped; `onProgress` follows the triangles written.
 */
export function encodeStl(parts: readonly ExportPart[], onProgress?: ProgressCallback): ArrayBuffer {
  const triangles = parts.reduce((sum, part) => sum + part.mesh.indices.length / 3, 0);
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triangles, true);
  let offset = 84;
  let written = 0;
  // Binary STL record: normal, three vertices (12 f32), then a 2-byte attribute count left 0.
  // The (x, -z, y) swap turns Y-up plate space into the Z-up frame slicers expect.
  const write = (x: number, y: number, z: number) => {
    view.setFloat32(offset, x, true);
    view.setFloat32(offset + 4, -z, true);
    view.setFloat32(offset + 8, y, true);
    offset += 12;
  };
  for (const { mesh, transform } of parts) {
    const { positions, indices } = mesh;
    const vertex = (index: number) => transformPoint(transform, [positions[index * 3]!, positions[index * 3 + 1]!, positions[index * 3 + 2]!]);
    for (let t = 0; t < indices.length; t += 3) {
      const a = vertex(indices[t]!);
      const b = vertex(indices[t + 1]!);
      const c = vertex(indices[t + 2]!);
      // Normal of (c - b) x (a - b), the same winding the viewport renders.
      const u = [c[0] - b[0], c[1] - b[1], c[2] - b[2]];
      const v = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
      const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const length = Math.hypot(n[0]!, n[1]!, n[2]!) || 1;
      write(n[0]! / length, n[1]! / length, n[2]! / length);
      write(a[0], a[1], a[2]);
      write(b[0], b[1], b[2]);
      write(c[0], c[1], c[2]);
      offset += 2;
      written += 1;
      if (onProgress && written % 20000 === 0) onProgress(written / triangles, PROGRESS_STAGE.writingStl);
    }
  }
  onProgress?.(1, PROGRESS_STAGE.writingStl);
  return buffer;
}

/** Filesystem-safe `.stl` names; repeats get `-2`, `-3`, ... in order. */
export function uniqueFileNames(names: readonly string[]): string[] {
  const used = new Map<string, number>();
  return names.map((name) => {
    const safe = name.replace(/[^A-Za-z0-9._ -]+/g, '-').replace(/^-+|-+$/g, '').trim() || 'unit';
    const count = (used.get(safe) ?? 0) + 1;
    used.set(safe, count);
    return count === 1 ? `${safe}.stl` : `${safe}-${count}.stl`;
  });
}
