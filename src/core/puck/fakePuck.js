// A puck that is not there, reached with `?puck=fake`.
//
// It exists so the whole workflow - the control, Line up, the orbit, the battery readout - can be
// driven, demonstrated and judged on a machine with no hardware and no Bluetooth radio. It is NOT
// a test double standing in for a unit test; `orbit.test.ts` does that job properly. This is for
// the one question a test cannot answer: **does the view turn the way the hand expects?**
//
// So the motion is deliberate and written down rather than random:
//
//   0.0 - 2.5 s   perfectly still, because that is what a person does: put it down, let it settle.
//                 A fake that never stops moving is a fake that Line up correctly refuses for
//                 ever, which would exercise the rejection and nothing else.
//   at 2.0 s      a DOUBLE-TAP event, as if the thumb had confirmed the pose. This is the only
//                 way the confirming gesture of PROTOCOL.md s6 can be seen without hardware, and
//                 it is the path `PuckLink._onEvent` takes - so `?puck=fake` demonstrates the
//                 whole workflow hands-free: connect, settle, confirm, turn.
//   2.5 s on      first a TILT, forward and back once about the puck's own +Y, while no yaw has
//                 accumulated yet - so it reads on screen as a clean change of elevation and
//                 nothing else. Then a slow YAW about the top face, in the positive sense, which
//                 is ANTICLOCKWISE SEEN FROM ABOVE.
//   every 8 s     the yaw pauses and the tilt happens again. Later tilts are about the puck's own
//                 axis, which the yaw has by then swung round, so they move BOTH angles - that is
//                 the hand's own geometry and not a fault. The first tilt is the clean one.
//
// **What to look for.** The scene should appear to swing ANTICLOCKWISE with the puck - the same
// way the model would have turned if the hand had been holding the model instead. The camera
// itself travels the other way round the scene, which is exactly what makes the model look like it
// is turning in the hand rather than the room turning around it.
//
// If it goes the other way, or if the tilt and the yaw are swapped, the fingerprint table in
// `orbit.ts`'s `toWorldFrame` says which of four things is wrong and where the one line is. That
// map is DERIVED, twice over and from different starting points, so a disagreement here is
// evidence about the puck or the holding, not a free parameter to flip.

/** Milliseconds between readings. The real puck reports at 50-100 Hz; this is the slow end. */
const INTERVAL_MS = 50;

/** How long the puck sits still at the start. Long enough for Line up to settle AND be confirmed. */
const STILL_S = 2.5;

/** When the fake "double-taps" itself: inside the still window, with the steady run already taken. */
const CONFIRM_S = 2;

/** Radians per second of yaw. A quarter turn takes about four seconds - slow enough to watch. */
const YAW_RATE = 0.4;

/** The tilt interlude: when it happens, how long it lasts, and how far it goes. */
const TILT_PERIOD_S = 8;
const TILT_LENGTH_S = 2;
const TILT_RADIANS = 0.7;

/**
 * Build the fake source. Same shape as `vendor/mixospatial-puck/puck.js`: `on`, `connect`,
 * `disconnect`, `sleepNow`.
 */
export function fakePuck() {
  const handlers = new Map();
  let timer = null;
  let elapsed = 0;

  const emit = (event, ...args) => {
    for (const handler of handlers.get(event) || []) handler(...args);
  };

  /** The pose at `t` seconds: a yaw about the puck's +Z, with a tilt about its +Y laid over it. */
  const poseAt = (t) => {
    const moving = Math.max(0, t - STILL_S);
    const phase = moving % TILT_PERIOD_S;
    // Yaw STOPS during a tilt, so the two are never read as one diagonal sweep - which means the
    // yaw angle is the elapsed time MINUS every second spent tilting, this period's and all the
    // ones before it. Subtracting only the current period's would step the yaw backwards at each
    // boundary, and a fake that jumps is a fake that gets blamed on the filter.
    const tiltedFor = Math.floor(moving / TILT_PERIOD_S) * TILT_LENGTH_S + Math.min(phase, TILT_LENGTH_S);
    const yaw = (moving - tiltedFor) * YAW_RATE;
    const tilt = phase < TILT_LENGTH_S
      ? TILT_RADIANS * Math.sin((phase / TILT_LENGTH_S) * Math.PI)
      : 0;

    // Yaw then tilt, as Hamilton products of the two axis rotations. Written out rather than
    // imported so this file stays readable next to what it claims to do above.
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    const ct = Math.cos(tilt / 2);
    const st = Math.sin(tilt / 2);

    return { x: -sy * st, y: cy * st, z: sy * ct, w: cy * ct };
  };

  return {
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },

    connect() {
      // Back to still: a reconnect is somebody picking it up again, and a fake that resumes
      // mid-sweep can never satisfy Line up - which is a property of the fake, not of the puck.
      elapsed = 0;
      emit('state', 'connecting');

      setTimeout(() => {
        emit('state', 'connected');
        emit('battery', 76);
        /* A fitted cell on USB, so the charging bolt and the percentage can both be seen without a
         * cell wired - the part of this readout a person most wants to look at before the hardware
         * exists. */
        emit('batteryStatus', { present: true, charging: true, wiredPower: true });

        timer = setInterval(() => {
          const was = elapsed;

          elapsed += INTERVAL_MS / 1000;
          emit('orientation', { q: poseAt(elapsed), status: 0 });

          // Once, on the reading that crosses the mark - after a whole second of stillness has
          // been collected, and before the puck starts to turn.
          if (was < CONFIRM_S && elapsed >= CONFIRM_S) emit('event', { eventName: 'doubleTap' });
        }, INTERVAL_MS);
      }, 200);
    },

    disconnect() {
      clearInterval(timer);
      timer = null;
      emit('state', 'idle');
    },

    /** There is no device to put to sleep; answering is what the caller needs. */
    sleepNow() {
      return Promise.resolve();
    },

    /** Pretend the link dropped, which must not look like a disconnect. For a hand check. */
    drop() {
      clearInterval(timer);
      timer = null;
      emit('state', 'lost', 'puckLostReason');
    },
  };
}
