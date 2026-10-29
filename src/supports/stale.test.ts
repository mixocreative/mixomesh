// Plan P3.1 stale rule: built supports go stale on rotate, scale and repair (geometry), not on
// translate; the flag is derived, so undoing the change clears it again.
import './testEnv';
/* eslint-disable @typescript-eslint/no-explicit-any -- state.scene.objects is untyped JS state */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TriangleMesh } from '@mixo-geocore/host/core/analysis/types';
import { dispatch, getState, setState } from '../core/StateManager.js';
import { EVENTS } from '../core/events.js';
import { clear, undo } from '../core/HistoryManager.js';
import { commitSupportEdits, DeleteSupportsCommand, LiftForSupportsCommand, type LiftScene, type WorldTransform } from './commands';
import { meshFromEngine, type BabylonPart } from './frame';
import { emptySupports, type SupportPose } from './model';
import { SourceHashCache, hashParts } from './sourceHash';
import { installStaleWatch, type SupportSceneSource } from './stale';
import { readSupports } from './store';
import { cubeOverhang } from '../../tests/fixtures/support-cubes.mjs';

/** The engine cube as the lead-local Babylon part a glTF import holds. */
function cubePart(nudge = 0): BabylonPart {
  const engine = cubeOverhang() as TriangleMesh;
  const positions = Float32Array.from(engine.positions);
  positions[1]! += nudge;   // a repair that moves one vertex
  const back = meshFromEngine({ positions, indices: engine.indices }, true);
  return { positions: back.positions, indices: back.indices, clockwise: true };
}

/** A fake scene: lead pose + translation, and a geometry revision; the hash goes through the real cache. */
class FakeScene implements SupportSceneSource {
  pose_: SupportPose = { rotation: [0, 0, 0, 1], scale: [1, 1, 1] };
  position = [0, 0, 0];
  revision = 0;
  hashes = new SourceHashCache();
  computed = 0;
  pose() { return structuredClone(this.pose_); }
  sourceHash(id: string) {
    return this.hashes.get(id, `lead@${this.revision}`, () => { this.computed++; return [cubePart(this.revision % 2 ? 0.5 : 0)]; });
  }
  forgetHash(id?: string) { this.hashes.forget(id); }
}

let scene: FakeScene;
let off: (() => void) | undefined;

beforeEach(() => {
  off?.();
  clear();
  scene = new FakeScene();
  setState((s: any) => ({
    ...s,
    scene: { ...s.scene, objects: {
      lead: { id: 'lead', logicalObjectId: 'lead', supports: { ...emptySupports(), sourceHash: hashParts([cubePart()]), pose: scene.pose(), revision: 1 } },
      part: { id: 'part', logicalObjectId: 'lead', isInternalPart: true },
      bare: { id: 'bare' },
    } },
  }), { silent: true });
  off = installStaleWatch(scene);
});

const stale = () => readSupports('lead')!.stale;
const transformed = (ids = ['lead', 'part']) => dispatch(EVENTS.TRANSFORM_COMMITTED, { meshIds: ids });

describe('stale supports', () => {
  it('rotate marks them stale (pose); rotating back clears it', () => {
    scene.pose_.rotation = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    transformed();
    expect(stale()).toBe('pose');
    scene.pose_.rotation = [0, 0, 0, -1];   // the same rotation as identity (q = -q)
    transformed(['part']);
    expect(stale()).toBeNull();
  });

  it('scale marks them stale (pose)', () => {
    scene.pose_.scale = [1, 1.5, 1];
    transformed();
    expect(stale()).toBe('pose');
  });

  it('translate does not, and costs no re-hash', () => {
    scene.position = [12, 3, -4];
    transformed();
    expect(stale()).toBeNull();
    expect(scene.computed).toBe(0);
  });

  it('repair (a geometry revision with other geometry) marks them stale (geometry); its undo clears it', () => {
    scene.revision = 1;
    dispatch(EVENTS.GEOMETRY_CHANGED, { meshId: 'part', revision: 1 });
    expect(stale()).toBe('geometry');
    scene.revision = 2;   // undo of the repair: the old geometry under a new revision
    dispatch(EVENTS.GEOMETRY_CHANGED, { meshId: 'part', revision: 2 });
    expect(stale()).toBeNull();
  });

  it('a lift (height only) never makes supports stale', () => {
    const tr: Record<string, WorldTransform> = { lead: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0, w: 1 }, scaling: { x: 1, y: 1, z: 1 } } };
    const lift: LiftScene = { parts: () => ['lead'], minY: () => tr.lead!.position.y, capture: (id) => structuredClone(tr[id]!), apply: (s) => Object.assign(tr, structuredClone(s)) };
    commitSupportEdits([new LiftForSupportsCommand('lead', 5, lift)]);
    expect(tr.lead!.position.y).toBeCloseTo(0.005, 9);
    expect(stale()).toBeNull();
  });

  it('the flag is written outside history and survives a support edit + undo consistently', () => {
    scene.pose_.scale = [2, 2, 2];
    transformed();
    commitSupportEdits([new DeleteSupportsCommand('lead', ['auto-a'])]);
    expect(stale()).toBe('pose');
    undo();
    expect(stale()).toBe('pose');
    expect(readSupports('lead')!.deleted).toEqual([]);
  });

  it('objects whose supports were never built are never stale', () => {
    setState((s: any) => ({ ...s, scene: { ...s.scene, objects: { ...s.scene.objects, lead: { ...s.scene.objects.lead, supports: emptySupports() } } } }), { silent: true });
    scene.pose_.scale = [3, 3, 3];
    transformed();
    expect(stale()).toBeNull();
    expect(getState().scene.objects.bare.supports).toBeUndefined();
  });
});
