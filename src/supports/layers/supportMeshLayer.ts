/**
 * The support mesh of one object (plan P3.3): one Babylon mesh whose triangles are regrouped by
 * part kind into one sub-mesh per kind over the shared kind materials (materials.ts). Vertices are
 * the engine's, unchanged (frame.ts `meshFromEngine` at the anchor), so `contactVertexRuns` of the
 * built mesh address them directly: selection and removal highlights recolour vertex ranges in
 * place (one colour-buffer update, no rebuild). Tips only (previewMode ONLY_TIP) draws the engine's
 * tips view (`tipsOf`) over the same vertices and materials. The mesh follows the lead's translation (`follow`, per frame, Babylon side).
 */
import type { GeneratedSupportMesh } from '@mixo-geocore/host/core/supports/mesh';
import { contactVertexRuns } from '@mixo-geocore/editing/selectionHighlight';
import { tipsOf } from '@mixo-geocore/host/core/supports/meshQuery';
import { meshFromEngine, type Vec3 } from '../frame';
import type { SupportAnchor } from '../BabylonViewportPort';
import { KIND_INDEX, PART_KINDS, partKind, supportMaterials, type PartKind } from './materials';
import { tagSupportLayer } from './supportLayerTag.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- Babylon is the untyped window global here */

export type PreviewMode = 'FULL' | 'ONLY_TIP';

export interface KindRange {
  kind: PartKind;
  /** First index into the regrouped index list, and the number of indices. */
  start: number;
  count: number;
}

/**
 * The triangles of a built mesh regrouped by part kind (stable within a kind), kinds in
 * `PART_KINDS` order. Triangles outside every component count as pillar.
 */
export function groupByKind(mesh: Pick<GeneratedSupportMesh, 'indices' | 'components'>): { indices: Uint32Array; ranges: KindRange[] } {
  const triangles = mesh.indices.length / 3;
  const kindOf = new Uint8Array(triangles).fill(KIND_INDEX.pillar);
  for (const component of mesh.components) {
    const k = KIND_INDEX[partKind(component)];
    for (let t = component.start / 3; t < (component.start + component.count) / 3; t++) kindOf[t] = k;
  }
  const counts = new Uint32Array(PART_KINDS.length);
  for (let t = 0; t < triangles; t++) counts[kindOf[t]!]!++;
  const offsets = new Uint32Array(PART_KINDS.length);
  const ranges: KindRange[] = [];
  let at = 0;
  for (let k = 0; k < PART_KINDS.length; k++) {
    offsets[k] = at;
    if (counts[k]) ranges.push({ kind: PART_KINDS[k]!, start: at * 3, count: counts[k]! * 3 });
    at += counts[k]!;
  }
  const indices = new Uint32Array(mesh.indices.length);
  for (let t = 0; t < triangles; t++) {
    const o = offsets[kindOf[t]!]!++ * 3;
    indices[o] = mesh.indices[t * 3]!;
    indices[o + 1] = mesh.indices[t * 3 + 1]!;
    indices[o + 2] = mesh.indices[t * 3 + 2]!;
  }
  return { indices, ranges };
}

/** Highlight colours (multiplied into the kind colour by the vertex colours). */
const SELECTED: readonly number[] = [1.0, 0.55, 0.2, 1];
const REMOVING: readonly number[] = [1.0, 0.2, 0.18, 1];
const PLAIN: readonly number[] = [1, 1, 1, 1];

export class SupportMeshLayer {
  readonly mesh: any;
  /** Tips only (previewMode ONLY_TIP): the engine's tips view (`tipsOf`: tips, necks, landing ends) over the same vertices; made on first use per build. */
  private tips: any;
  private positions: Float32Array = new Float32Array(0);
  private normals: Float32Array = new Float32Array(0);
  private runs = new Map<string, [number, number][]>();
  private colors: Float32Array = new Float32Array(0);
  private painted = new Map<string, 'selected' | 'removing'>();
  private selected = new Set<string>();
  private removing = new Set<string>();
  private mode: PreviewMode = 'FULL';
  private stale = false;
  built: GeneratedSupportMesh | undefined;
  anchor: SupportAnchor | undefined;

  constructor(private readonly B: any, private readonly scene: any, private readonly root: any, readonly objectId: string) {
    this.mesh = this.makeMesh(`mx-support-${objectId}`);
  }

  private makeMesh(name: string): any {
    const mesh = new this.B.Mesh(name, this.scene);
    mesh.parent = this.root;
    tagSupportLayer(mesh, 'supports', this.objectId);
    mesh.setEnabled(false);
    return mesh;
  }

  /** Fill `target` with the shared vertices, `source`'s triangles regrouped by kind, one sub-mesh per kind. */
  private fill(target: any, source: Pick<GeneratedSupportMesh, 'indices' | 'components'>): number {
    const B = this.B;
    const { indices, ranges } = groupByKind(source);
    const data = new B.VertexData();
    data.positions = this.positions;
    data.indices = indices;
    data.normals = this.normals;
    data.colors = this.colors;
    data.applyToMesh(target, true);
    const m = supportMaterials(B, this.scene);
    target.material = this.stale ? m.stale : m.kinds;
    const vertices = target.getTotalVertices();
    target.subMeshes = [];
    for (const r of ranges) new B.SubMesh(KIND_INDEX[r.kind], 0, vertices, r.start, r.count, target);
    if (!ranges.length) new B.SubMesh(KIND_INDEX.tip, 0, vertices, 0, 0, target);
    target.position.copyFrom(this.mesh.position);
    return indices.length;
  }

  /** Replace the drawn supports (support-local mesh, its anchor). */
  set(built: GeneratedSupportMesh, anchor: SupportAnchor): void {
    const B = this.B;
    this.built = built;
    this.anchor = anchor;
    const world = new Float32Array(built.positions.length);
    for (let i = 0; i < world.length; i++) world[i] = built.positions[i]! + anchor.center[i % 3]!;
    this.positions = meshFromEngine({ positions: world, indices: new Uint32Array(0) }, false).positions;
    this.normals = new Float32Array(this.positions.length);
    B.VertexData.ComputeNormals(this.positions, built.indices, this.normals);
    this.colors = new Float32Array((this.positions.length / 3) * 4).fill(1);
    this.runs = contactVertexRuns(built);
    this.painted.clear();
    this.tips?.dispose(false, false);
    this.tips = undefined;
    const count = this.fill(this.mesh, built);
    this.recolour(true);
    this.mesh.setEnabled(count > 0 && this.mode === 'FULL');
    if (this.mode === 'ONLY_TIP') this.showTips();
  }

  private showTips(): void {
    if (!this.built) return;
    if (!this.tips) {
      this.tips = this.makeMesh(`mx-support-tips-${this.objectId}`);
      this.fill(this.tips, tipsOf(this.built));
    }
    this.tips.setEnabled(true);
    this.mesh.setEnabled(false);
  }

  clear(): void {
    this.built = undefined;
    this.anchor = undefined;
    this.mesh.setEnabled(false);
    this.tips?.setEnabled(false);
  }

  setStale(stale: boolean): void {
    if (stale === this.stale) return;
    this.stale = stale;
    const m = supportMaterials(this.B, this.scene);
    this.mesh.material = stale ? m.stale : m.kinds;
    if (this.tips) this.tips.material = this.mesh.material;
  }

  isStale(): boolean {
    return this.stale;
  }

  setPreviewMode(mode: PreviewMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    if (!this.built) return;
    if (mode === 'ONLY_TIP') this.showTips();
    else {
      this.tips?.setEnabled(false);
      this.mesh.setEnabled(this.mesh.getTotalIndices() > 0);
    }
  }

  /** Selected and to-be-removed contact ids; only the vertex ranges that change colour are rewritten. */
  setHighlight(selected: Iterable<string>, removing: Iterable<string>): void {
    this.selected = new Set(selected);
    this.removing = new Set(removing);
    if (this.built) this.recolour();
  }

  selectedIds(): string[] {
    return [...this.selected];
  }

  removingIds(): string[] {
    return [...this.removing];
  }

  /** Babylon translation of the lead since the anchor (per frame). */
  follow(offset: Readonly<Vec3>): void {
    for (const mesh of this.tips ? [this.mesh, this.tips] : [this.mesh]) {
      const p = mesh.position;
      if (p.x !== offset[0] || p.y !== offset[1] || p.z !== offset[2]) p.set(offset[0], offset[1], offset[2]);
    }
  }

  /** The Babylon mesh drawn now (full or tips only). */
  drawnMesh(): any {
    return this.mode === 'ONLY_TIP' && this.tips ? this.tips : this.mesh;
  }

  /** Kinds drawn now (tests, tips-only check). */
  drawnKinds(): PartKind[] {
    return (this.drawnMesh().subMeshes ?? []).filter((s: any) => s.indexCount > 0).map((s: any) => PART_KINDS[s.materialIndex]!);
  }

  private recolour(force = false): void {
    const next = new Map<string, 'selected' | 'removing'>();
    for (const id of this.selected) next.set(id, 'selected');
    for (const id of this.removing) next.set(id, 'removing');
    let dirty = force;
    const paint = (id: string, rgba: readonly number[]) => {
      for (const [a, b] of this.runs.get(id) ?? []) {
        for (let v = a; v < b; v++) this.colors.set(rgba, v * 4);
        dirty = true;
      }
    };
    for (const [id, was] of this.painted) if (next.get(id) !== was) paint(id, PLAIN);
    for (const [id, kind] of next) if (this.painted.get(id) !== kind) paint(id, kind === 'selected' ? SELECTED : REMOVING);
    this.painted = next;
    if (!dirty) return;
    this.mesh.updateVerticesData(this.B.VertexBuffer.ColorKind, this.colors, false, false);
    this.tips?.updateVerticesData(this.B.VertexBuffer.ColorKind, this.colors, false, false);
  }

  dispose(): void {
    this.tips?.dispose(false, false);
    this.mesh.dispose(false, false);
  }
}
