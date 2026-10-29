/**
 * Zone stamp overlay (plan P3.3, port of mixosupports' SurfaceStampLayer): the no-support zones
 * drawn see-through over the model. The overlay holds the object's support-frame model (welded,
 * objectModel.ts) once per geometry version; a stamp change re-lays the stamps (only the new
 * ones when the list grew, every one after any other change) and rewrites the index list to the
 * triangles that touch a stamped vertex, so a small painted spot on a large model is a small draw.
 * Not refined on coarse faces (mixosupports' overlayMesh refinement is not ported; P5).
 */
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { buildVertexGrid, sameStamp, stampVertices, type VertexGrid, type ZoneStamp } from '@mixo-geocore/host/core/supports/zones';
import { meshFromEngine, type Vec3 } from '../frame';
import type { SupportAnchor } from '../BabylonViewportPort';
import { overlayMaterial } from './materials';
import { tagSupportLayer } from './supportLayerTag.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */

/** Vertex grid cell (mm), about a brush dab. */
const GRID_CELL_MM = 2;

/** Area-weighted vertex normals of an engine-frame mesh (counter-clockwise outward). */
export function vertexNormals(mesh: TriangleMesh): Float32Array {
  const p = mesh.positions;
  const ix = mesh.indices;
  const n = new Float32Array(p.length);
  for (let t = 0; t + 2 < ix.length; t += 3) {
    const a = ix[t]! * 3, b = ix[t + 1]! * 3, c = ix[t + 2]! * 3;
    const ux = p[b]! - p[a]!, uy = p[b + 1]! - p[a + 1]!, uz = p[b + 2]! - p[a + 2]!;
    const vx = p[c]! - p[a]!, vy = p[c + 1]! - p[a + 1]!, vz = p[c + 2]! - p[a + 2]!;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    for (const v of [a, b, c]) { n[v] += nx; n[v + 1] += ny; n[v + 2] += nz; }
  }
  for (let i = 0; i < n.length; i += 3) {
    const l = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!);
    if (l > 0) { n[i] /= l; n[i + 1] /= l; n[i + 2] /= l; }
  }
  return n;
}

/** Triangles (index triples) with at least one zoned vertex. */
export function zonedTriangles(indices: ArrayLike<number>, zoned: Uint8Array): Uint32Array {
  const out = new Uint32Array(indices.length);
  let used = 0;
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const a = indices[t]!, b = indices[t + 1]!, c = indices[t + 2]!;
    if (zoned[a] || zoned[b] || zoned[c]) { out[used++] = a; out[used++] = b; out[used++] = c; }
  }
  return out.slice(0, used);
}

export class ZoneOverlayLayer {
  readonly mesh: any;
  private version = '';
  private model: TriangleMesh | undefined;
  private normals: Float32Array = new Float32Array(0);
  private zoned: Uint8Array = new Uint8Array(0);
  private grid: VertexGrid | undefined;
  private applied: readonly ZoneStamp[] = [];
  anchor: SupportAnchor | undefined;
  /** Triangles drawn now (tests / smoke). */
  drawnTriangles = 0;

  constructor(private readonly B: any, scene: any, root: any, readonly objectId: string) {
    this.mesh = new B.Mesh(`mx-support-zones-${objectId}`, scene);
    this.mesh.parent = root;
    this.mesh.material = overlayMaterial(B, scene, 'zones', '#3b82c4', 0.45);
    tagSupportLayer(this.mesh, 'zones', objectId);
    this.mesh.setEnabled(false);
  }

  /** The support-frame model the stamps lie on; reloaded only when `version` changes. */
  setModel(model: TriangleMesh, anchor: SupportAnchor, version: string): void {
    this.anchor = anchor;
    if (version === this.version && this.model) return;
    this.version = version;
    this.model = model;
    this.normals = vertexNormals(model);
    this.zoned = new Uint8Array(model.positions.length / 3);
    this.grid = buildVertexGrid(model.positions as Float32Array, GRID_CELL_MM);
    this.applied = [];
    const world = new Float32Array(model.positions.length);
    for (let i = 0; i < world.length; i++) world[i] = model.positions[i]! + anchor.center[i % 3]!;
    const { positions } = meshFromEngine({ positions: world, indices: new Uint32Array(0) }, false);
    const data = new this.B.VertexData();
    data.positions = positions;
    data.indices = [];
    data.applyToMesh(this.mesh, true);
    this.drawnTriangles = 0;
    this.mesh.setEnabled(false);
  }

  /** Draw the zones the stamps make (support frame, last covering stamp wins). */
  setStamps(stamps: readonly ZoneStamp[]): void {
    const model = this.model;
    if (!model) return;
    const positions = model.positions as Float32Array;
    const done = this.applied;
    if (done.length <= stamps.length && done.every((s, i) => sameStamp(stamps[i]!, s))) {
      for (let i = done.length; i < stamps.length; i++) stampVertices(stamps[i]!, positions, this.normals, this.zoned, this.grid);
    } else {
      this.zoned.fill(0);
      for (const s of stamps) stampVertices(s, positions, this.normals, this.zoned, this.grid);
    }
    this.applied = [...stamps];
    const drawn = zonedTriangles(model.indices, this.zoned);
    this.drawnTriangles = drawn.length / 3;
    if (drawn.length) this.mesh.setIndices(drawn, model.positions.length / 3, true);
    this.mesh.setEnabled(drawn.length > 0);
  }

  follow(offset: Readonly<Vec3>): void {
    const p = this.mesh.position;
    if (p.x !== offset[0] || p.y !== offset[1] || p.z !== offset[2]) p.set(offset[0], offset[1], offset[2]);
  }

  dispose(): void {
    this.mesh.dispose(false, false);
  }
}
