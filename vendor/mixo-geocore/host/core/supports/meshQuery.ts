import type { TriangleMesh } from '../analysis/types';
import type { GeneratedSupportMesh, SupportComponent } from './mesh';
import type { Vector } from '../vec3';

/** Bounding box of a mesh's vertices. */
export function meshBounds(mesh: TriangleMesh): { min: Vector; max: Vector } {
  const min: Vector = [Infinity, Infinity, Infinity];
  const max: Vector = [-Infinity, -Infinity, -Infinity];
  for (let offset = 0; offset < mesh.positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, mesh.positions[offset + axis]!);
      max[axis] = Math.max(max[axis]!, mesh.positions[offset + axis]!);
    }
  }
  return { min, max };
}

/**
 * The contact tips alone (tip spheres and necks) of a built support mesh, for viewing contact
 * points without pillars, braces or raft. Shares the vertices; contacts still pick.
 */
export function tipsOf(mesh: GeneratedSupportMesh): GeneratedSupportMesh {
  const kept: { component: SupportComponent; triangles: Uint32Array }[] = [];
  for (const component of mesh.components) {
    const triangles = mesh.indices.subarray(component.start, component.start + component.count);
    if (component.part === 'tip' || component.part === 'neck') kept.push({ component, triangles });
    else if (component.landingReach !== undefined) kept.push({ component: { part: 'neck', ...(component.contactId ? { contactId: component.contactId } : {}), start: 0, count: 0 }, triangles: landingEnd(mesh.positions, triangles, component.landingReach) });
  }
  const indices = new Uint32Array(kept.reduce((total, entry) => total + entry.triangles.length, 0));
  const components: SupportComponent[] = [];
  let offset = 0;
  for (const { component, triangles } of kept) {
    if (triangles.length === 0) continue;
    indices.set(triangles, offset);
    components.push({ ...component, start: offset, count: triangles.length });
    offset += triangles.length;
  }
  const parts = (['tip', 'neck'] as const).filter((part) => components.some((component) => component.part === part));
  return { positions: mesh.positions, indices, parts, components, dropped: mesh.dropped,
    ...(mesh.droppedByZones ? { droppedByZones: mesh.droppedByZones } : {}) };
}

/** Triangles of a tube within `reach` of its end (its last vertex): the landing tip of a landing pillar. */
function landingEnd(positions: Float32Array, triangles: Uint32Array, reach: number): Uint32Array {
  let last = 0;
  for (const vertex of triangles) if (vertex > last) last = vertex;
  const [ex, ey, ez] = [positions[last * 3]!, positions[last * 3 + 1]!, positions[last * 3 + 2]!];
  const near = (vertex: number) => Math.hypot(positions[vertex * 3]! - ex, positions[vertex * 3 + 1]! - ey, positions[vertex * 3 + 2]! - ez) <= reach;
  const out: number[] = [];
  for (let i = 0; i < triangles.length; i += 3) {
    if (near(triangles[i]!) && near(triangles[i + 1]!) && near(triangles[i + 2]!)) out.push(triangles[i]!, triangles[i + 1]!, triangles[i + 2]!);
  }
  return Uint32Array.from(out);
}

/** Contact that owns a triangle of the generated mesh, if any. */
export function contactAtTriangle(mesh: GeneratedSupportMesh, triangle: number): string | undefined {
  const index = triangle * 3;
  let low = 0;
  let high = mesh.components.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const component = mesh.components[middle]!;
    if (index < component.start) high = middle - 1;
    else if (index >= component.start + component.count) low = middle + 1;
    else return component.contactId;
  }
  return undefined;
}
