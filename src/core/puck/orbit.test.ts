import { describe, expect, it } from 'vitest';
import {
  angleBetween,
  averageQuaternions,
  cameraOrbit,
  directionOf,
  heldStill,
  multiply,
  normalise,
  orbitOf,
  readStatus,
  relativeTo,
  rotate,
  toWorldFrame,
  type Orbit,
  type Quaternion,
} from './orbit';

/*
 * These are the rules `orbit.ts` claims, asserted rather than believed — the module's own header
 * says the basis change was DERIVED and not measured, so everything the derivation does settle is
 * pinned here. What a test cannot settle is whether the result LOOKS right on a left-handed
 * Babylon stage; that needs the device, and `toWorldFrame`'s comment says what to look for.
 *
 * The exactness below is the point. A puck yaw of theta about its top face must move `alpha` by
 * exactly theta and leave `beta` alone — not approximately, not mostly. A mapping that leaks yaw
 * into tilt is the failure that would be blamed on the hardware.
 */

/** Rotation by `angle` about a unit axis, in the puck's own frame. */
function about(axis: 'x' | 'y' | 'z', angle: number): Quaternion {
  const half = angle / 2;
  const s = Math.sin(half);

  return {
    x: axis === 'x' ? s : 0,
    y: axis === 'y' ? s : 0,
    z: axis === 'z' ? s : 0,
    w: Math.cos(half),
  };
}

const IDENTITY: Quaternion = { x: 0, y: 0, z: 0, w: 1 };
const HOME: Orbit = { alpha: Math.PI / 3, beta: Math.PI / 4 };
const FRONT: Orbit = { alpha: Math.PI / 2, beta: Math.PI / 2 };

describe('orbit — the direction/angle pair', () => {
  it('round-trips every orbit away from the poles', () => {
    for (const alpha of [0, 0.7, Math.PI / 2, 2.5, -1.2]) {
      for (const beta of [0.3, Math.PI / 4, Math.PI / 2, 2.4]) {
        const back = orbitOf(directionOf({ alpha, beta }));

        expect(back.beta).toBeCloseTo(beta, 10);
        // `alpha` is only defined modulo a full turn, which `atan2` returns in (-pi, pi].
        expect(Math.cos(back.alpha)).toBeCloseTo(Math.cos(alpha), 10);
        expect(Math.sin(back.alpha)).toBeCloseTo(Math.sin(alpha), 10);
      }
    }
  });

  it('never returns a beta sitting on a pole', () => {
    for (const v of [{ x: 0, y: 1, z: 0 }, { x: 0, y: -1, z: 0 }]) {
      const { beta } = orbitOf(v);

      expect(beta).toBeGreaterThan(0);
      expect(beta).toBeLessThan(Math.PI);
    }
  });

  it('answers something usable for a zero-length direction', () => {
    expect(orbitOf({ x: 0, y: 0, z: 0 })).toEqual({ alpha: 0, beta: Math.PI / 2 });
  });
});

describe('orbit — a reading becomes a view', () => {
  it('leaves the view exactly where it was homed when the puck has not moved', () => {
    const held = about('z', 1.1);
    const { alpha, beta } = cameraOrbit(HOME, held, held);

    expect(beta).toBeCloseTo(HOME.beta, 10);
    expect(Math.cos(alpha)).toBeCloseTo(Math.cos(HOME.alpha), 10);
  });

  it('swings the view the way the hand swung the puck, by exactly as much', () => {
    /*
     * THE SIGN IS THE WHOLE TEST, and it is the thing that shipped wrong once. The chain, in one
     * place, because every link of it is invisible until a hand is holding the puck:
     *
     *  - yaw is rotation about the puck's top face, its +Z (PROTOCOL.md section 2), and the
     *    puck's frame is right-handed, so +theta is ANTICLOCKWISE seen from above.
     *  - at the FRONT view Babylon's camera is on +Z and world +X is the viewer's LEFT, so
     *    increasing `alpha` swings the camera from +X toward +Z and the scene APPEARS to turn
     *    clockwise seen from above.
     *  - matching the hand therefore means `alpha` must DECREASE by the same angle.
     *
     * `orbit.ts`'s `toWorldFrame` carries the derivation; this is its consequence, stated where
     * a future sign flip cannot pass.
     */
    for (const turn of [0.4, -0.9, 2.0]) {
      const { alpha, beta } = cameraOrbit(HOME, IDENTITY, about('z', turn));

      expect(beta).toBeCloseTo(HOME.beta, 10);
      expect(Math.cos(alpha)).toBeCloseTo(Math.cos(HOME.alpha - turn), 10);
      expect(Math.sin(alpha)).toBeCloseTo(Math.sin(HOME.alpha - turn), 10);
    }
  });

  it('turns a puck tilt into the same angle of elevation, and no swing', () => {
    // From the front view, tipping about the puck's +Y raises or lowers the camera only.
    const tilt = 0.3;
    const { alpha, beta } = cameraOrbit(FRONT, IDENTITY, about('y', tilt));

    expect(beta).toBeCloseTo(FRONT.beta + tilt, 10);
    expect(Math.sin(alpha)).toBeCloseTo(1, 10);
  });

  it('carries on through the pole instead of sticking to it', () => {
    // Past vertical: beta comes back DOWN while alpha turns through half a circle. A clamp that
    // merely pinned beta would leave the view stuck pointing at the ceiling.
    const { alpha, beta } = cameraOrbit(FRONT, IDENTITY, about('y', Math.PI / 2 + 0.4));

    expect(beta).toBeCloseTo(Math.PI - 0.4, 10);
    expect(Math.sin(alpha)).toBeCloseTo(-1, 10);
  });

  it('measures the turn from the pose captured at Line up, not from boot', () => {
    // The puck's yaw starts at an arbitrary angle on every wake (no magnetometer), so the zero is
    // the only thing that makes a reading mean anything.
    const zero = about('z', 2.7);
    const after = cameraOrbit(HOME, zero, multiply(zero, about('z', 0.5)));

    expect(after.alpha).toBeCloseTo(HOME.alpha - 0.5, 8);
  });
});

describe('orbit — the basis change', () => {
  it('puts every puck axis where the hand says it goes', () => {
    /*
     * Each of these is a half-turn about one puck axis, and a half-turn about an axis is the same
     * rotation about its opposite — so what is pinned here is the AXIS, with its sign free:
     *
     *   +X, the connector, pointing away from the person  ->  world -Z, away from the viewer
     *   +Y, which a right-handed puck puts on the person's LEFT  ->  world +X, the viewer's left
     *   +Z, the top face  ->  world +Y, up
     *
     * The second row is the one that was wrong. Sending +Y to world -X made the map a proper
     * rotation, which is tidy and puts the person's left hand on the puck's right.
     *
     * Summed rather than compared field by field: the map negates components, so an axis that
     * lands on zero lands on NEGATIVE zero, which `toEqual` rightly refuses to call 0.
     */
    const axes = (q: Quaternion) => [q.x + 0, q.y + 0, q.z + 0, q.w + 0];

    expect(axes(toWorldFrame({ x: 1, y: 0, z: 0, w: 0 }))).toEqual([0, 0, 1, 0]);
    expect(axes(toWorldFrame({ x: 0, y: 1, z: 0, w: 0 }))).toEqual([-1, 0, 0, 0]);
    expect(axes(toWorldFrame({ x: 0, y: 0, z: 1, w: 0 }))).toEqual([0, -1, 0, 0]);
  });

  it('agrees with mixo-ar, carried across the two worlds handedness', () => {
    /*
     * mixo-ar drives the same puck through three.js, whose world is right-handed: same Y-up, same
     * +Z toward the viewer, but +X is the viewer's RIGHT. Its map is verified against the device.
     * Babylon's world is that one reflected in X, and a rotation carried through a reflection `M`
     * transforms as `det(M)*M*v` — here `(x, y, z) -> (x, -y, -z)`.
     *
     * So this is the SECOND derivation of the same function, from a different starting point. If
     * one of them is ever edited alone, this fails.
     */
    const mixoAr = (q: Quaternion) => ({ x: -q.y, y: q.z, z: -q.x, w: q.w });
    const intoBabylon = (q: Quaternion) => ({ x: q.x, y: -q.y, z: -q.z, w: q.w });

    for (const q of [about('x', 0.6), about('y', -1.1), about('z', 2.2), normalise({ x: 0.3, y: -0.5, z: 0.2, w: 0.8 })]) {
      expect(toWorldFrame(q)).toEqual(intoBabylon(mixoAr(q)));
    }
  });

  it('leaves w alone, so the angle of the turn survives it', () => {
    expect(toWorldFrame(about('z', 1.3)).w).toBeCloseTo(Math.cos(0.65), 12);
  });
});

describe('orbit — rotating a direction', () => {
  it('turns a unit vector by the quaternion and keeps its length', () => {
    const turned = rotate(about('y', Math.PI / 2), { x: 1, y: 0, z: 0 });

    // A quarter turn about +Y sends +X to -Z (right-handed, which is what `q v q-1` means).
    expect(turned.x).toBeCloseTo(0, 10);
    expect(turned.y).toBeCloseTo(0, 10);
    expect(turned.z).toBeCloseTo(-1, 10);
  });
});

describe('orbit — Line up', () => {
  it('averages a run of readings', () => {
    const run = [about('z', 0.98), about('z', 1), about('z', 1.02)];

    expect(angleBetween(averageQuaternions(run)!, about('z', 1))).toBeLessThan(0.7);
  });

  it('averages q and -q to the same rotation rather than cancelling them', () => {
    // The hypersphere trap: both describe one orientation, and a naive sum is the zero quaternion.
    const q = about('z', 1);
    const flipped: Quaternion = { x: -q.x, y: -q.y, z: -q.z, w: -q.w };
    const mean = averageQuaternions([q, flipped])!;

    expect(Math.hypot(mean.x, mean.y, mean.z, mean.w)).toBeCloseTo(1, 10);
    expect(angleBetween(mean, q)).toBeCloseTo(0, 6);
  });

  it('has no answer for an empty run', () => {
    expect(averageQuaternions([])).toBeNull();
  });

  it('refuses a run that moved, and accepts one that did not', () => {
    expect(heldStill([about('z', 0), about('z', 0.5)])).toBe(false);
    expect(heldStill([about('z', 0), about('z', 0.005)])).toBe(true);
    // One sample is not evidence of stillness, whatever it says.
    expect(heldStill([about('z', 0)])).toBe(false);
  });
});

describe('orbit — the odds and ends', () => {
  it('reads the status bits of PROTOCOL.md section 5', () => {
    expect(readStatus(0)).toEqual({ still: false, lowBattery: false, noSensor: false });
    expect(readStatus(0b1101)).toEqual({ still: true, lowBattery: true, noSensor: true });
    expect(readStatus(0b0010).still).toBe(false);   // bit 1 is retired, not a flag
  });

  it('hands back the raw reading when there is no zero yet', () => {
    const q = about('z', 0.4);

    expect(relativeTo(null, q)).toEqual(normalise(q));
  });

  it('survives a zero-length quaternion rather than returning NaN', () => {
    expect(normalise({ x: 0, y: 0, z: 0, w: 0 })).toEqual({ x: 0, y: 0, z: 0, w: 1 });
  });
});
