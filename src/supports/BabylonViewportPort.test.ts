// BabylonViewportPort (plan P3.3) against a NullEngine scene: screen <-> world round trips at
// device pixel ratio 1 and 2, perspective and orthographic, the brush view's clip matrix, and
// picks answered by the real engine session in the support frame (lead follow included).
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as B from '@babylonjs/core';
import { configureGeometry, geometryReady, sharedSession } from '@mixo-geocore/host/workers/geometryClient';
import {
  BabylonViewportPort, SessionPickMeshes, anchorOffset, babylonToSupport, invert, multiply, supportToBabylon,
  supportToBabylonMatrix, transform4, type PickSession, type SupportAnchor,
} from './BabylonViewportPort';
import type { Vec3 } from './frame';

const VENDOR = fileURLToPath(new URL('../../public/vendor/mixo-geocore/', import.meta.url));

let engine: B.NullEngine | undefined;
afterEach(() => { engine?.dispose(); engine = undefined; });

/** A scene whose drawing buffer is `dpr` times the CSS box (800 x 450 CSS px). */
function setup(dpr: number, ortho = false) {
  engine = new B.NullEngine({ renderWidth: 800 * dpr, renderHeight: 450 * dpr, textureSize: 32, deterministicLockstep: false, lockstepMaxSteps: 1 });
  const scene = new B.Scene(engine);
  const camera = new B.ArcRotateCamera('cam', 0.7, 1.1, 0.4, new B.Vector3(0.01, 0.02, -0.03), scene);
  camera.minZ = 0.001;
  if (ortho) {
    camera.mode = B.Camera.ORTHOGRAPHIC_CAMERA;
    camera.orthoLeft = -0.2; camera.orthoRight = 0.2; camera.orthoTop = 0.1125; camera.orthoBottom = -0.1125;
  }
  scene.activeCamera = camera;
  let lead: Vec3 = [0, 0, 0];
  const picks = new SessionPickMeshes(() => sharedSession() as unknown as PickSession | undefined);
  const port = new BabylonViewportPort({
    camera: () => scene.activeCamera, cssSize: () => ({ width: 800, height: 450 }), leadPosition: () => lead, picks,
  });
  return { scene, camera, port, picks, moveLead: (p: Vec3) => { lead = p; } };
}

const near = (a: readonly number[], b: readonly number[], eps: number) => a.every((v, i) => Math.abs(v - b[i]!) <= eps);

/** Distance from point p to the ray. */
function rayDistance(ray: { origin: readonly number[]; direction: readonly number[] }, p: readonly number[]): number {
  const v = p.map((x, i) => x - ray.origin[i]!);
  const t = v.reduce((s, x, i) => s + x * ray.direction[i]!, 0);
  const q = v.map((x, i) => x - t * ray.direction[i]!);
  return Math.hypot(...q);
}

describe('matrix helpers', () => {
  it('invert(M) * M is the identity', () => {
    const m = B.Matrix.Compose(new B.Vector3(1, 2, 3), B.Quaternion.RotationYawPitchRoll(0.3, -0.4, 0.9), new B.Vector3(0.5, 4, -2)).m;
    const id = multiply(invert(m)!, m);
    expect(near(Array.from(id), Array.from(B.Matrix.Identity().m), 1e-12)).toBe(true);
  });
});

describe.each([1, 2])('screen <-> world at device pixel ratio %i', (dpr) => {
  it('reports the CSS size and the ratio of the drawing buffer to it', () => {
    const { port } = setup(dpr);
    expect(port.size()).toEqual({ width: 800, height: 450, devicePixelRatio: dpr });
  });

  for (const ortho of [false, true]) {
    it(`${ortho ? 'orthographic' : 'perspective'}: worldToScreen then screenToRay passes through the point`, () => {
      const { port } = setup(dpr, ortho);
      for (const p of [[0, 0, 0], [0.05, 0.03, -0.02], [-0.04, 0.08, 0.06]] as Vec3[]) {
        const s = port.worldToScreen(p)!;
        expect(s).toBeDefined();
        const ray = port.screenToRay(s)!;
        expect(Math.hypot(...ray.direction)).toBeCloseTo(1, 12);
        expect(rayDistance(ray, p)).toBeLessThan(1e-9);
        // and back: a point along that ray lands on the same pixel
        const q: Vec3 = [ray.origin[0] + ray.direction[0] * 0.3, ray.origin[1] + ray.direction[1] * 0.3, ray.origin[2] + ray.direction[2] * 0.3];
        expect(near(port.worldToScreen(q)!, s, 1e-6)).toBe(true);
      }
    });

    it(`${ortho ? 'orthographic' : 'perspective'}: the centre pixel looks along the camera axis`, () => {
      const { port, camera } = setup(dpr, ortho);
      const ray = port.screenToRay([400, 225])!;
      const f = camera.target.subtract(camera.position).normalize();
      // Babylon keeps camera matrices in float32: agreement to ~1e-8.
      expect(near(ray.direction, [f.x, f.y, f.z], 1e-6)).toBe(true);
      expect(rayDistance(ray, [camera.target.x, camera.target.y, camera.target.z])).toBeLessThan(1e-6);
    });
  }

  it('the target projects to the centre in CSS px, whatever the ratio', () => {
    const { port, camera } = setup(dpr);
    const s = port.worldToScreen([camera.target.x, camera.target.y, camera.target.z])!;
    expect(near(s, [400, 225], 1e-6)).toBe(true);
  });

  it('a point behind the eye has no screen point', () => {
    const { port, camera } = setup(dpr);
    const back = camera.position.add(camera.position.subtract(camera.target));
    expect(port.worldToScreen([back.x, back.y, back.z])).toBeUndefined();
  });
});

describe('support frame', () => {
  const anchor: SupportAnchor = { center: [10, 20, 30], lead: [0.5, 0, 0.25] };

  it('support <-> Babylon round trip with the lead moved', () => {
    const offset = anchorOffset(anchor, [0.6, 0.1, 0.2]);
    const s: Vec3 = [1.5, -2, 3.25];
    const b = supportToBabylon(s, anchor, offset);
    // Engine Z is Babylon -Z, mm vs metres, plus the lead's move.
    expect(near(b, [(1.5 + 10) / 1000 + 0.1, (-2 + 20) / 1000 + 0.1, -(3.25 + 30) / 1000 - 0.05], 1e-12)).toBe(true);
    expect(near(babylonToSupport(b, anchor, offset), s, 1e-9)).toBe(true);
    const m = supportToBabylonMatrix(anchor, offset);
    const h = transform4(s, m);
    expect(near(h.slice(0, 3), b, 1e-12)).toBe(true);
  });

  it('brushView clip maps a support-local point to the same pixel as worldToScreen of its Babylon point', () => {
    const { scene, picks, moveLead } = setup(2);
    moveLead([0.52, 0.01, 0.2]);
    const port = new BabylonViewportPort({
      camera: () => scene.activeCamera, cssSize: () => ({ width: 800, height: 450 }), leadPosition: () => [0.52, 0.01, 0.2], picks,
      brushFrame: () => ({ objectId: 'a', anchor }),
    });
    const view = port.brushView();
    expect([view.width, view.height]).toEqual([800, 450]);
    const offset = anchorOffset(anchor, [0.52, 0.01, 0.2]);
    for (const s of [[0, 0, 0], [4, -3, 2]] as Vec3[]) {
      const [x, y, , w] = transform4(s, view.clip);
      const px = [((x / w + 1) / 2) * view.width, ((1 - y / w) / 2) * view.height];
      expect(near(px, port.worldToScreen(supportToBabylon(s, anchor, offset))!, 1e-6)).toBe(true);
    }
    const eye = scene.activeCamera!.globalPosition;
    expect(near(view.eye, babylonToSupport([eye.x, eye.y, eye.z], anchor, offset), 1e-9)).toBe(true);
  });
});

describe('picks through the engine session', () => {
  beforeAll(async () => {
    configureGeometry(pathToFileURL(VENDOR + 'mixo_geometry_wasm.js').href, readFileSync(VENDOR + 'mixo_geometry_wasm_bg.wasm'));
    await geometryReady();
  });

  // A 10 mm engine-frame square at engine y = 5 (support-local), facing +Y (counter-clockwise from above).
  const square = {
    positions: Float32Array.of(-5, 5, -5, 5, 5, -5, 5, 5, 5, -5, 5, 5),
    indices: Uint32Array.of(0, 2, 1, 0, 3, 2),
  };
  const anchor: SupportAnchor = { center: [100, 0, -50], lead: [0, 0, 0] };

  it('a downward ray hits the support-local square where the frame says, normal up, distance in BU', () => {
    const { picks, port, moveLead } = setup(1);
    const handle = picks.handle('sq', 'v1', () => ({ objectId: 'a', anchor, mesh: square, side: 0 }))!;
    expect(handle).toBeTypeOf('number');
    // Support-local (2, 5, 3) -> engine (102, 5, -47) -> Babylon (0.102, 0.005, 0.047).
    const hit = port.pick(handle, { origin: [0.102, 0.105, 0.047], direction: [0, -1, 0] })!;
    expect(hit).toBeDefined();
    expect(near(hit.point, [0.102, 0.005, 0.047], 1e-6)).toBe(true);
    expect(near(hit.normal, [0, 1, 0], 1e-9)).toBe(true);
    expect(hit.distance).toBeCloseTo(0.1, 6);
    // Back faces are not hit with side 0; a ray off the square misses.
    expect(port.pick(handle, { origin: [0.102, -0.1, 0.047], direction: [0, 1, 0] })).toBeUndefined();
    expect(port.pick(handle, { origin: [0.2, 0.105, 0.047], direction: [0, -1, 0] })).toBeUndefined();
    // The lead moves 1 cm in +X: the square follows.
    moveLead([0.01, 0, 0]);
    expect(port.pick(handle, { origin: [0.102, 0.105, 0.047], direction: [0, -1, 0] })).toBeUndefined();
    expect(near(port.pick(handle, { origin: [0.112, 0.105, 0.047], direction: [0, -1, 0] })!.point, [0.112, 0.005, 0.047], 1e-6)).toBe(true);
    picks.clear();
  });

  it('loads a mesh once per version and releases the old one', () => {
    let loads = 0;
    let releases = 0;
    const fake: PickSession = {
      load_mesh: () => ++loads,
      release_mesh: () => { releases++; },
      pick: () => Float64Array.of(-1, 0, 0, 0, 0),
    };
    const picks = new SessionPickMeshes(() => fake);
    let made = 0;
    const make = () => { made++; return { objectId: 'a', anchor, mesh: square, side: 0 }; };
    const h1 = picks.handle('m', 'v1', make);
    expect(picks.handle('m', 'v1', make)).toBe(h1);
    expect([loads, made, releases]).toEqual([1, 1, 0]);
    const h2 = picks.handle('m', 'v2', make);
    expect(h2).not.toBe(h1);
    expect([loads, made, releases]).toEqual([2, 2, 1]);
    expect(picks.target(h1!)).toBeUndefined();
    picks.clear();
    expect(releases).toBe(2);
  });
});
