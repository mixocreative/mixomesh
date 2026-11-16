// What a puck reading MEANS for the camera. No Bluetooth, no Babylon, no DOM — pure arithmetic,
// so every rule below is testable in `orbit.test.ts` without hardware or a scene.
//
// The puck (mixocreative/mixospatial) sends a unit quaternion and nothing else: component order
// `x, y, z, w`, and **no zero on the wire** — `PROTOCOL.md` §3 puts the reference pose in the host,
// because the device has no magnetometer and its yaw restarts at an arbitrary angle on every wake.
// So this module is handed the pose captured at Line up (`qZero`) and works in `qZero⁻¹ · q`.
//
// The difference from `mixo-ar`, which drives the same puck: there the MODEL turns, here the CAMERA
// orbits. The image is the same either way — see `cameraOrbit` for why, and for the one inversion
// that makes it so.

/** Component order as it arrives on the wire. */
export interface Quaternion { x: number; y: number; z: number; w: number }

/** A direction in mixomesh world axes. Y is up. */
export interface Vector3 { x: number; y: number; z: number }

/** Babylon `ArcRotateCamera` angles: `alpha` around the up axis, `beta` down from it. */
export interface Orbit { alpha: number; beta: number }

const DEGREES = 180 / Math.PI;

/**
 * How close `beta` may come to straight up or straight down.
 *
 * The same epsilon the mouse orbit uses (`CameraRig._orbit`), and for the same reason: at exactly
 * 0 or π the camera's up vector is parallel to its view direction and the view matrix degenerates.
 * The puck can be tipped through vertical — `beta` comes back down the other side while `alpha`
 * turns through 180°, which is the correct motion — but it is never left sitting on the pole.
 */
const POLE_EPSILON = 0.01;

/** Hamilton product: `q` then `r`. */
export function multiply(q: Quaternion, r: Quaternion): Quaternion {
  return {
    x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
    y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
    z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
    w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
  };
}

/** The inverse of a *unit* quaternion, which is its conjugate. */
export function conjugate(q: Quaternion): Quaternion {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function normalise(q: Quaternion): Quaternion {
  const length = Math.hypot(q.x, q.y, q.z, q.w);

  if (length === 0) return { x: 0, y: 0, z: 0, w: 1 };

  return { x: q.x / length, y: q.y / length, z: q.z / length, w: q.w / length };
}

/** The reading relative to the pose captured at Line up. Without a zero, the reading itself. */
export function relativeTo(qZero: Quaternion | null, q: Quaternion): Quaternion {
  if (!qZero) return normalise(q);

  return normalise(multiply(conjugate(normalise(qZero)), normalise(q)));
}

/**
 * The puck's rotation expressed in MIXOMESH WORLD AXES instead of the puck's own.
 *
 * Three facts fix this map. The third is the one that is easy to get backwards, and this file
 * once did.
 *
 * **1. The puck's axes** (`mixospatial/PROTOCOL.md` §2, after the firmware's mounting
 * correction): **+X is the connector**, **+Z is the top face**, and +Y completes a RIGHT-handed
 * set. So with the puck lying flat, top up, connector pointing away from the person,
 * `+Y = +Z × +X` = up × away = **the person's LEFT**.
 *
 * **2. mixomesh's world axes.** Y is up, and `CameraRig.setCameraPreset` fixes the rest: the
 * FRONT view puts the camera on +Z, so **+Z is toward the viewer** and **world +X is the viewer's
 * LEFT**. That second half is not a convention somebody chose — Babylon's left-handed look-at
 * builds the camera's right as `up × forward`, which for a camera at +Z looking back is
 * `(0,1,0) × (0,0,-1) = (-1,0,0)`. The comment in `setCameraPreset` says the same thing, and the
 * NavCube agrees with it.
 *
 * **3. So the axes correspond as `+X -> -Z`, `+Y -> +X`, `+Z -> +Y`, and that map's determinant
 * is -1.** It is not an error to be tidied away. Babylon's (viewer's-left, up, toward-viewer) is a
 * LEFT-handed labelling of physical space while an IMU's frame is right-handed, and no proper
 * rotation carries one onto the other. Under a basis change `B` a quaternion's vector part becomes
 * `det(B)·B·v` with `w` unchanged, so the sign is carried rather than wished away:
 * `B·v = (y, z, -x)`, and with `det(B) = -1` that is **`(-y, -z, x)`**.
 *
 * **The cross-check, against the one place this is proven in service.** `mixo-ar` drives the same
 * puck through three.js, whose world is RIGHT-handed: same Y-up, same +Z toward the viewer, but
 * +X is the viewer's RIGHT. Its map, verified by hand against the device, is
 * `(x, y, z) -> (-y, z, -x)`. Going from three.js coordinates to Babylon's is the reflection
 * `X_bab = -X_three`, and transporting a rotation through a reflection `M` uses that same
 * `det(M)·M·v` rule, which here is `(x, y, z) -> (x, -y, -z)`. Apply it to mixo-ar's map and
 * you get `(-y, -z, x)`: this function, exactly. Two derivations from different starting points,
 * one answer.
 *
 * ---------------------------------------------------------------------------------------------
 * **AN EARLIER VERSION OF THIS FILE HAD THE YAW BACKWARDS, and the comment that shipped with it
 * said the question needed hardware to settle. It did not.** That version picked
 * `+Y -> world -X` to force the determinant to +1 — the arithmetic looked tidier, and turning
 * the puck anticlockwise on the desk swung the scene clockwise. Choosing the third axis to make
 * the determinant come out is choosing which side of the puck the person's left hand is on; it is
 * the one thing here that is not free. Fix the axes by what the hand does, then let the
 * determinant say what it says.
 *
 * If it is ever wrong again, read the fingerprint before touching anything:
 *
 * | what you see | what it means | where the fix is |
 * |---|---|---|
 * | yaw mirrored, tilt correct | this map's third axis, i.e. fact 1 or 2 above | here |
 * | every rotation mirrored | the `det(B)` sign | here |
 * | two axes reversed, the third correct | a HEADING error, 180° about the correct one | not here — ask how the puck is being HELD, then measure the device |
 * | everything reversed together | the inversion in `cameraOrbit` | there, not here |
 *
 * `?puck=fake` turns the view without hardware: it tilts once, cleanly, then yaws anticlockwise
 * seen from above, so the scene should swing anticlockwise with it.
 */
export function toWorldFrame(q: Quaternion): Quaternion {
  return { x: -q.y, y: -q.z, z: q.x, w: q.w };
}

/** Rotate a direction by a unit quaternion: `q v q⁻¹`. */
export function rotate(q: Quaternion, v: Vector3): Vector3 {
  const { x, y, z, w } = q;
  // t = 2 (q_vec × v), then v' = v + w t + q_vec × t. Fewer multiplies than building the matrix,
  // and no matrix to get transposed by accident.
  const tx = 2 * (y * v.z - z * v.y);
  const ty = 2 * (z * v.x - x * v.z);
  const tz = 2 * (x * v.y - y * v.x);

  return {
    x: v.x + w * tx + y * tz - z * ty,
    y: v.y + w * ty + z * tx - x * tz,
    z: v.z + w * tz + x * ty - y * tx,
  };
}

/**
 * The unit offset from the camera's target to the camera, for an orbit.
 *
 * Babylon's own formula, from `ArcRotateCamera`: `target + radius·(sinβ cosα, cosβ, sinβ sinα)`.
 * It is restated in `CameraRig._setupCamera` and in the initial camera state; this is the inverse
 * pair of that one expression, so the two cannot drift apart silently.
 */
export function directionOf({ alpha, beta }: Orbit): Vector3 {
  return {
    x: Math.sin(beta) * Math.cos(alpha),
    y: Math.cos(beta),
    z: Math.sin(beta) * Math.sin(alpha),
  };
}

/** The orbit that puts the camera along `v`. The exact inverse of `directionOf`, poles aside. */
export function orbitOf(v: Vector3): Orbit {
  const length = Math.hypot(v.x, v.y, v.z);

  if (length === 0) return { alpha: 0, beta: Math.PI / 2 };

  const up = Math.min(1, Math.max(-1, v.y / length));
  const beta = Math.acos(up);

  return {
    // At the pole `v.x` and `v.z` are both 0 and `alpha` is genuinely undefined — any value shows
    // the same view. `atan2(0, 0)` is 0, which is as good an answer as exists.
    alpha: Math.atan2(v.z, v.x),
    beta: Math.min(Math.PI - POLE_EPSILON, Math.max(POLE_EPSILON, beta)),
  };
}

/**
 * **The whole point of this module:** where the camera goes for one puck reading.
 *
 * `home` is the orbit the camera was homed to when Line up was confirmed, and `qZero` the pose the
 * puck was held in at that moment. The two together say "this pose means this view".
 *
 * **The inversion is deliberate and is what makes this look like `mixo-ar`.** There the puck's
 * rotation `R` is applied to the MODEL, so a point `p` is drawn at `R·p`. Here the model does not
 * move, so the camera must be orbited by `R⁻¹` instead: writing the camera's pose as position `c`
 * and orientation `Rc`, a point lands in the camera's frame at `Rc⁻¹(p − c)`, and rotating the
 * whole camera by `S` about the target gives `(S·Rc)⁻¹(p − S·c) = Rc⁻¹(S⁻¹·p − c)`. That is the
 * same image as rotating the model by `S⁻¹`. So `S = R⁻¹`, and turning the puck right swings the
 * view around the model exactly as if the hand had turned the model itself.
 *
 * **Roll is dropped, and that is the camera's doing, not a loss here.** An `ArcRotateCamera` has
 * two angles and no roll: tipping the puck about the axis the camera is looking down has nowhere to
 * go, so the horizon stays level. For orbiting a scene that is the wanted behaviour — the
 * alternative is a view that lolls sideways and has to be straightened by hand.
 */
export function cameraOrbit(home: Orbit, qZero: Quaternion | null, q: Quaternion): Orbit {
  const turn = toWorldFrame(relativeTo(qZero, q));

  return orbitOf(rotate(conjugate(turn), directionOf(home)));
}

/**
 * The average of a run of readings, for Line up.
 *
 * An instant sample catches the nudge of whatever started the capture, so the reference is taken
 * over a short run instead. Quaternions are averaged by summing with a sign flip for any reading on
 * the far side of the hypersphere from the first — `q` and `−q` are the same rotation, and summing
 * them naively cancels to nothing.
 */
export function averageQuaternions(readings: Quaternion[]): Quaternion | null {
  if (!Array.isArray(readings) || readings.length === 0) return null;

  const first = normalise(readings[0]);
  const sum = { x: 0, y: 0, z: 0, w: 0 };

  for (const reading of readings) {
    const q = normalise(reading);
    const sign = (q.x * first.x + q.y * first.y + q.z * first.z + q.w * first.w) < 0 ? -1 : 1;

    sum.x += sign * q.x;
    sum.y += sign * q.y;
    sum.z += sign * q.z;
    sum.w += sign * q.w;
  }

  return normalise(sum);
}

/** The angle between two orientations, in degrees — how much the hand moved. */
export function angleBetween(a: Quaternion, b: Quaternion): number {
  const p = normalise(a);
  const q = normalise(b);
  const dot = Math.min(1, Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w));

  return 2 * Math.acos(dot) * DEGREES;
}

/** Was the puck actually still through the capture? Averaging a moving puck is averaging noise. */
export function heldStill(readings: Quaternion[], tolerance = 2): boolean {
  if (!Array.isArray(readings) || readings.length < 2) return false;

  const reference = readings[0];

  return readings.every((reading) => angleBetween(reference, reading) <= tolerance);
}

/** The `status` byte of `PROTOCOL.md` §5, as the three bits that mean something to this app. */
export function readStatus(byte: number): { still: boolean; lowBattery: boolean; noSensor: boolean } {
  const bits = Number(byte) || 0;

  return {
    still: (bits & 0b0001) !== 0,
    lowBattery: (bits & 0b0100) !== 0,
    // §5: the quaternion is identity and means nothing, but the packet is kept — the bit is the
    // information, and discarding it would throw away the only evidence of what is wrong.
    noSensor: (bits & 0b1000) !== 0,
  };
}
