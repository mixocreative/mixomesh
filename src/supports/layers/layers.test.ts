// Support layers (plan P3.3) on a NullEngine scene: the D20 predicate and render hide, kind
// grouping over shared materials, tips only, stale grey, in-place highlight, zone overlay drawing
// stamped triangles only, and the layers following the lead.
import '../testEnv';
import { afterEach, describe, expect, it } from 'vitest';
import * as B from '@babylonjs/core';
import type { GeneratedSupportMesh } from '@mixo-geocore/host/core/supports/mesh';
import { ISOLATION_LAYER_BIT, hideSupportLayers, isSupportLayerMesh, seeIsolatedObjects, tagSupportLayer, withoutSupportLayers } from './supportLayerTag.js';

// The isolation layer used to be declared twice -- here via supportLayerTag and again in
// SupportMode.ts -- and this file pinned them equal by reading the second one out of its SOURCE with
// a regex, because importing SupportMode pulls the app graph in. There is one definition now
// (supportLayerTag, re-exported by src/ui/isolation.ts), so there is nothing left to pin.
import { groupByKind } from './supportMeshLayer';
import { zonedTriangles } from './zoneOverlay';
import { SupportLayers } from './index';
import { worldExtentsOf } from '../../core/scene/WorldExtents.js';
import type { Vec3 } from '../frame';

let engine: B.NullEngine | undefined;
afterEach(() => { engine?.dispose(); engine = undefined; });

function scene() {
  engine = new B.NullEngine({ renderWidth: 800, renderHeight: 450, textureSize: 32, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const s = new B.Scene(engine);
  s.activeCamera = new B.ArcRotateCamera('cam', 0.7, 1.1, 0.3, B.Vector3.Zero(), s);
  return s;
}

/** Two contacts, each tip + pillar, plus one brace: 5 boxes of 12 triangles, components in build order. */
function builtMesh(): GeneratedSupportMesh {
  const positions: number[] = [];
  const indices: number[] = [];
  const components: GeneratedSupportMesh['components'] = [];
  const box = (part: GeneratedSupportMesh['components'][number]['part'], at: Vec3, contactId?: string) => {
    const b = B.MeshBuilder.CreateBox('tmp', { size: 2 });
    const p = b.getVerticesData('position')!;
    const i = b.getIndices()!;
    const base = positions.length / 3;
    const start = indices.length;
    for (let k = 0; k < p.length; k += 3) positions.push(p[k]! + at[0], p[k + 1]! + at[1], p[k + 2]! + at[2]);
    for (const v of i) indices.push(v + base);
    components.push({ part, start, count: i.length, ...(contactId ? { contactId } : {}) });
    b.dispose();
  };
  box('pillar', [0, 0, 0], 'c1');
  box('tip', [0, 5, 0], 'c1');
  box('brace', [3, 0, 0]);
  box('tip', [6, 5, 0], 'c2');
  box('pillar', [6, 0, 0], 'c2');
  return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices), parts: [], components, dropped: [] };
}

describe('D20 predicate', () => {
  it('tags a node and everything under it; content meshes are not support layers', () => {
    const s = scene();
    const root = tagSupportLayer(new B.TransformNode('root', s), 'root');
    const child = new B.Mesh('child', s);
    child.parent = root;
    const content = new B.Mesh('content', s);
    content.metadata = { meshId: 'm1' };
    expect(isSupportLayerMesh(root)).toBe(true);
    expect(isSupportLayerMesh(child)).toBe(true);
    expect(isSupportLayerMesh(content)).toBe(false);
    expect(withoutSupportLayers([root, child, content])).toEqual([content]);
    const tagged = tagSupportLayer(new B.Mesh('x', s), 'ghost', 'o1');
    expect(tagged.isPickable).toBe(false);
    expect(tagged.metadata).toEqual({ supportLayer: 'ghost', supportOf: 'o1' });
  });

  it('renders see Support Mode isolated objects (output ignores the isolation mask)', () => {
    const s = scene();
    const camera = s.activeCamera!;
    const masked = new B.Mesh('masked', s);
    masked.layerMask = ISOLATION_LAYER_BIT;
    const plain = new B.Mesh('plain', s);
    expect(camera.layerMask & masked.layerMask).toBe(0);
    const restore = seeIsolatedObjects(s);
    expect(masked.layerMask & camera.layerMask).toBe(camera.layerMask & 0x0fffffff);
    expect(plain.layerMask).toBe(0x0fffffff);
    restore();
    expect(masked.layerMask).toBe(ISOLATION_LAYER_BIT);
  });

  it('world extents never include a support layer', () => {
    const s = scene();
    const box = B.MeshBuilder.CreateBox('b', { size: 1 }, s);
    expect(worldExtentsOf(box)).not.toBeNull();
    tagSupportLayer(box, 'supports');
    expect(worldExtentsOf(box)).toBeNull();
  });
});

describe('SupportLayers', () => {
  const anchor = { center: [0, 0, 0] as Vec3, lead: [0, 0, 0] as Vec3 };

  it('every layer node is tagged, unpickable, without meshId, under one root that renders disable', () => {
    const s = scene();
    const layers = new SupportLayers(s, { babylon: B, leadPosition: () => [0, 0, 0], session: () => undefined });
    layers.setSupports('o1', builtMesh(), anchor);
    layers.setZones('o1', builtMesh(), anchor, 'v1', []);
    const all = [layers.root, ...layers.meshes()];
    expect(all.length).toBeGreaterThanOrEqual(6);
    for (const m of all) {
      expect(isSupportLayerMesh(m)).toBe(true);
      expect(m.metadata?.meshId).toBeUndefined();
      if (m !== layers.root) expect((m as B.AbstractMesh).isPickable).toBe(false);
    }
    const mesh = layers.supportLayer('o1')!.mesh;
    expect(mesh.isEnabled()).toBe(true);
    const restore = hideSupportLayers();
    expect(mesh.isEnabled()).toBe(false);
    restore();
    expect(mesh.isEnabled()).toBe(true);
    layers.dispose();
  });

  it('groups triangles by part kind over the shared kind materials; tips only keeps the tip sub-mesh', () => {
    const s = scene();
    const built = builtMesh();
    const { indices, ranges } = groupByKind(built);
    expect(ranges.map((r) => [r.kind, r.count / 3])).toEqual([['tip', 24], ['pillar', 24], ['brace', 12]]);
    expect([...indices].sort((a, b) => a - b)).toEqual([...built.indices].sort((a, b) => a - b));

    const layers = new SupportLayers(s, { babylon: B, leadPosition: () => [0, 0, 0], session: () => undefined });
    const a = layers.setSupports('o1', built, anchor);
    const b = layers.setSupports('o2', builtMesh(), anchor);
    expect(a.mesh.material).toBe(b.mesh.material);
    expect(a.drawnKinds()).toEqual(['tip', 'pillar', 'brace']);
    const material = a.mesh.material;
    layers.setSupports('o1', builtMesh(), anchor);
    expect(a.mesh.material).toBe(material);
    layers.setPreviewMode('ONLY_TIP');
    expect(a.drawnKinds()).toEqual(['tip']);
    layers.setPreviewMode('FULL');
    expect(a.drawnKinds()).toEqual(['tip', 'pillar', 'brace']);
    layers.setStale('o1', true);
    expect(a.mesh.material).not.toBe(material);
    expect(b.mesh.material).toBe(material);
    layers.dispose();
  });

  it('selection and removal recolour only their contacts\' vertices', () => {
    const s = scene();
    const layers = new SupportLayers(s, { babylon: B, leadPosition: () => [0, 0, 0], session: () => undefined });
    const layer = layers.setSupports('o1', builtMesh(), anchor);
    const colours = () => layer.mesh.getVerticesData(B.VertexBuffer.ColorKind)!;
    const white = (from: number, to: number) => Array.from(colours().slice(from * 4, to * 4)).every((v) => v === 1);
    // 24 vertices per box: c1 = boxes 0-1 (vertices 0..47), brace 48..71, c2 = 72..119.
    layers.setSelection('o1', ['c2']);
    expect(white(0, 72)).toBe(true);
    expect(white(72, 120)).toBe(false);
    const doomed = layers.setRemoveRing('o1', { point: [0, 0.005, 0], normal: [0, 1, 0], radiusMm: 3 }, [
      { id: 'c1', position: [0, 5, 0] }, { id: 'c2', position: [6, 5, 0] },
    ]);
    expect(doomed).toBe('c1');
    expect(white(0, 48)).toBe(false);
    expect(white(48, 72)).toBe(true);
    layers.setSelection('o1', []);
    layers.setRemoveRing('o1', undefined);
    expect(white(0, 120)).toBe(true);
    layers.dispose();
  });

  it('the zone overlay draws only the triangles that touch a stamped vertex', () => {
    expect(Array.from(zonedTriangles([0, 1, 2, 3, 4, 5, 6, 7, 8], Uint8Array.of(0, 0, 0, 0, 1, 0, 0, 0, 0)))).toEqual([3, 4, 5]);
    const s = scene();
    const layers = new SupportLayers(s, { babylon: B, leadPosition: () => [0, 0, 0], session: () => undefined });
    // A 20 x 20 mm grid of quads at y = 0, facing +Y (engine frame, counter-clockwise from above).
    const n = 21;
    const positions = new Float32Array(n * n * 3);
    for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) positions.set([x - 10, 0, z - 10], (z * n + x) * 3);
    const indices: number[] = [];
    for (let z = 0; z < n - 1; z++) for (let x = 0; x < n - 1; x++) {
      const a = z * n + x, b = a + 1, c = a + n, d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
    const model = { positions, indices: Uint32Array.from(indices) };
    const zones = layers.setZones('o1', model, anchor, 'v1', []);
    expect(zones.drawnTriangles).toBe(0);
    expect(zones.mesh.isEnabled()).toBe(false);
    const stamp = { kind: 'paint' as const, center: [0, 0, 0] as Vec3, radius: 1.5, normal: [0, 1, 0] as Vec3 };
    layers.setZones('o1', model, anchor, 'v1', [stamp]);
    // Vertices within 1.5 mm of the centre: 9 (3 x 3); triangles touching them: the 4 x 4 quad block
    // around them (32) less the two corner triangles whose diagonal misses the zoned corner vertex.
    expect(zones.drawnTriangles).toBe(30);
    expect(zones.mesh.getTotalIndices()).toBe(30 * 3);
    expect(zones.mesh.isEnabled()).toBe(true);
    // A stamp facing away lays nothing; erase clears.
    layers.setZones('o1', model, anchor, 'v1', [stamp, { ...stamp, center: [8, 0, 8], normal: [0, -1, 0] }]);
    expect(zones.drawnTriangles).toBe(30);
    layers.setZones('o1', model, anchor, 'v1', [stamp, { ...stamp, kind: 'erase', radius: 3 }]);
    expect(zones.drawnTriangles).toBe(0);
    layers.dispose();
  });

  it('follows the lead translation each frame', () => {
    const s = scene();
    let lead: Vec3 = [0.1, 0, 0];
    const layers = new SupportLayers(s, { babylon: B, leadPosition: () => lead, session: () => undefined });
    const layer = layers.setSupports('o1', builtMesh(), { center: [0, 0, 0], lead: [0.1, 0, 0] });
    expect(layer.mesh.position.asArray()).toEqual([0, 0, 0]);
    lead = [0.15, 0.02, -0.01];
    s.render();
    expect(layer.mesh.position.x).toBeCloseTo(0.05, 9);
    expect(layer.mesh.position.y).toBeCloseTo(0.02, 9);
    expect(layer.mesh.position.z).toBeCloseTo(-0.01, 9);
    layers.dispose();
  });
});
