// The orientation puck as a camera: the link, the alignment, and who owns the orbit.
//
// One job, in three parts that cannot be split without one of them lying:
//
//   1. the LINK - connect, disconnect, and what a dropped radio means (it is not a disconnect)
//   2. LINE UP - the reference pose, averaged over a run of readings the person held still
//   3. DRIVING - every reading becomes an orbit, through `orbit.ts` and `CameraRig.orbitTo`
//
// What is NOT here: bytes (`vendor/mixospatial-puck/`), arithmetic (`orbit.ts`), and markup
// (`ui/PuckPanel.js`). This module holds the state those three have no business holding, which is
// why the panel reads `snapshot()` instead of keeping its own copy - `src/ui/README.md`'s rule.
//
// The decisions this implements rather than re-argues, all from `mixospatial/docs/decisions/`:
//
//   0006 / PROTOCOL.md s3  the zero lives in the HOST. The puck has no magnetometer, so its yaw
//                          restarts at an arbitrary angle on every wake and a stored zero would be
//                          valid for tilt only. Nothing is ever sent to the puck, so Line up
//                          cannot fail.
//   0009                   a deliberate Disconnect returns the view home; an unintended LINK LOSS
//                          freezes it where the hand left it and says why. An interruption is not
//                          an ending.
//   0010                   gated on `navigator.bluetooth` AND `getAvailability()`, never on
//                          "desktop": Web Bluetooth is Chrome and Edge only, absent in an iframe
//                          without permission and on a machine with no adapter, so a user-agent
//                          guess is wrong in both directions.
//
// **The one thing mixomesh does differently from `mixo-ar`:** there the puck turns the MODEL, here
// it orbits the CAMERA. The image is the same (see `orbit.cameraOrbit`), but the consequence is
// not - the puck takes the two camera ANGLES and leaves the target and the radius alone, so pan
// and zoom keep working while it turns. `CameraRig._orbit` is the matching half of that.

import { EVENTS } from '../events.js';
import { dispatch } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { HOME_ORBIT } from '../scene/SceneConstants.js';
import { averageQuaternions, cameraOrbit, heldStill, readStatus } from './orbit';
import { fakePuck } from './fakePuck.js';
import { createPuck } from '../../../vendor/mixospatial-puck/puck.js';
import {
  createWebBluetoothTransport,
  isAvailable,
} from '../../../vendor/mixospatial-puck/transport-web-bluetooth.js';

/** Readings arrive at 50-100 Hz, so half a second is tens of them. This is the floor, not a target. */
const ALIGN_MIN_READINGS = 5;

/** The camera preset Line up homes to. Its angles are `HOME_ORBIT`; the two must not drift apart. */
const HOME_PRESET = 'perspective';

let _source = null;

const _state = {
  /** Is there any point drawing the control? False until `isAvailable()` has said yes. */
  offered: false,
  /** 'idle' | 'connecting' | 'connected' | 'lost' - the vendored link's own vocabulary. */
  link: 'idle',
  battery: null,
  batteryStatus: null,
  /** True while the person is being asked to hold the puck the way they want to face the scene. */
  aligning: false,
  /** Which hint the align card shows: an i18n key, never a sentence. */
  hint: 'puck.alignAsk',
  /** s5: the sensor did not answer, the quaternion is identity and means nothing. */
  noSensor: false,
};

/** The reference pose, and the orbit it means. Both null until Line up finishes. */
let _qZero = null;
/**
 * The orbit the puck measures its turns FROM.
 *
 * `null` means "adopt wherever the camera ends up next, and take a fresh zero with it" - the
 * recovery path for a view that was moved by something else. See `_drive`.
 */
let _home = null;

/** The align window: everything seen so far, and the last run that was genuinely still. */
let _readings = [];
let _steady = [];

const _changed = () => dispatch(EVENTS.PUCK_CHANGED, {});

/** What the panel is allowed to know. A copy, so nothing outside can edit the live state. */
export function snapshot() {
  return {
    ..._state,
    /** Can Line up be confirmed right now? The button and the double-tap share this answer. */
    canFinish: _state.aligning && (_steady.length > 0 || _readings.length > 0),
  };
}

/**
 * One reading becomes one view.
 *
 * The re-home branch is what keeps the puck and the rest of the camera UI from fighting. Home, a
 * NavCube face or any other preset animates for 320 ms, and `CameraRig.orbitTo` refuses for the
 * whole of it; rather than dragging the view back, the puck gives up its reference and adopts the
 * pose the animation lands on, with THIS reading as the new zero. The effect is that a preset click
 * re-bases the puck instead of being undone by it, and the hand feels no jump - the first reading
 * after the animation maps to exactly the pose on screen.
 */
function _drive(q) {
  if (_home === null) {
    _home = SceneManager.currentOrbit();
    _qZero = q;
  }

  /*
   * NO REFERENCE MEANS NO MEANINGFUL ANGLE, so the first reading becomes one.
   *
   * The puck has no magnetometer: its yaw starts at a different angle every time it wakes. Driving
   * the camera from a raw reading would swing the view to an arbitrary heading the instant the link
   * came up, which reads as the puck moving on its own. Line up runs on connect and does the better
   * job - it averages a held-still run - but this is the floor underneath it, for the person who
   * dismisses the card.
   */
  if (_qZero === null) _qZero = q;

  const { alpha, beta } = cameraOrbit(_home, _qZero, q);

  if (!SceneManager.orbitTo(alpha, beta)) _home = null;
}

/** Collect the align window, and keep the last run that was actually still. */
function _collect(q) {
  _readings.push(q);

  if (!heldStill(_readings)) {
    // It moved: start the window again rather than average a gesture.
    _readings = [q];
    _state.hint = 'puck.alignHoldStill';
    _changed();

    return;
  }

  if (_readings.length < ALIGN_MIN_READINGS) return;

  /*
   * KEEP THE LAST STEADY WINDOW, BECAUSE TAPPING THE PUCK MOVES THE PUCK.
   *
   * The confirming gesture is a knock on the very object being held still, so by the time the
   * double-tap event arrives the window above has been reset by the knock and holds the
   * disturbance itself - the single worst reference available, and the one a naive implementation
   * would average. This keeps the last run that genuinely was still, so the tap confirms the pose
   * the person was holding rather than the one their finger just created.
   *
   * The button has the same problem in a quieter form - a hand leaving the puck to reach a mouse -
   * so it uses this too.
   */
  _steady = _readings.slice(-ALIGN_MIN_READINGS);

  if (_state.hint !== 'puck.alignReady') {
    _state.hint = 'puck.alignReady';
    _changed();
  }
}

/**
 * Start Line up: home the view, then ask.
 *
 * **THE VIEW IS HOMED FIRST, NOT AFTERWARDS.** The card asks the person to hold the puck the way
 * they want to face the scene, which is only answerable if they can already see which way that is.
 * Opening the card over a view still sitting at the last link's angle asks them to match something
 * to a target that is itself wrong, and whatever they then line up to is wrong by the same amount.
 */
export function beginAlign() {
  SceneManager.setCameraPreset(HOME_PRESET);

  _qZero = null;
  _home = null;
  _readings = [];
  /* Cleared with the readings: a steady window from the LAST alignment would silently confirm the
   * previous pose if the person tapped before holding still this time. */
  _steady = [];
  _state.aligning = true;
  _state.hint = 'puck.alignAsk';
  _holdLight(true);
  _changed();
}

/**
 * Take the reference and let the puck drive. Returns false when there is nothing to average yet.
 *
 * `_home` is the named constant rather than the camera's live orbit on purpose: Line up always
 * homes to `HOME_PRESET`, whose angles ARE `HOME_ORBIT`, and the preset animates for 320 ms. Asking
 * the camera where it is could therefore catch it mid-flight and set a reference a few degrees out,
 * which would show up as the puck being very slightly crooked and nothing else.
 */
export function finishAlign() {
  const settled = _steady.length > 0 ? _steady : _readings;

  if (settled.length === 0) return false;

  _qZero = averageQuaternions(settled.slice(-ALIGN_MIN_READINGS));
  _home = { ...HOME_ORBIT };
  _state.aligning = false;
  _holdLight(false);
  _changed();

  return true;
}

/** Walk away from the card. The link stays up and the floor in `_drive` takes over. */
export function cancelAlign() {
  _state.aligning = false;
  _holdLight(false);
  _changed();
}

/**
 * Keep the puck's blue LED lit while the align card is waiting on the person (mixospatial
 * decision 0017), and let it go when the card closes.
 *
 * **A courtesy, never a dependency.** Fire and forget: a puck built before the opcodes refuses
 * them, a dead link rejects the write, and none of that may stop an alignment. The puck lets go
 * by itself when the link drops, so the `idle` and `lost` branches below send nothing.
 */
function _holdLight(on) {
  try {
    const sent = on ? _source?.alignHold?.() : _source?.alignRelease?.();

    Promise.resolve(sent).catch(() => {});
  } catch {
    /* Nothing to light, nothing to tell. */
  }
}

function _onState(next) {
  const wasConnected = _state.link === 'connected';

  _state.link = next;

  if (next === 'connected') {
    // The puck owns the orbit from here: mouse and touch orbit are refused, pan and zoom are not.
    SceneManager.setPuckOrbit(true);
    // Until a reference is taken the view's angle means nothing, so the first connection walks
    // straight into Line up rather than leaving it to be discovered (0010).
    beginAlign();

    return;
  }

  if (next === 'idle' && wasConnected) {
    // Deliberate: the person said they were finished (0009).
    _qZero = null;
    _home = null;
    _state.aligning = false;
    _state.noSensor = false;
    SceneManager.setPuckOrbit(false);
    SceneManager.setCameraPreset(HOME_PRESET);
  }

  if (next === 'lost') {
    /*
     * Not deliberate, so THE VIEW STAYS EXACTLY WHERE THEIR HAND LEFT IT (0009) and the panel says
     * why. Snapping home on a dropped link would destroy the one thing the person was looking at,
     * for a reason that is usually a battery or a doorway.
     *
     * The mouse DOES get the orbit back, though. Nothing is driving the camera any more, so a drag
     * can no longer be overwritten - and frozen-and-unturnable would just be a dead viewport.
     */
    _state.aligning = false;
    SceneManager.setPuckOrbit(false);
  }

  _changed();
}

function _onOrientation({ q, status }) {
  const flags = readStatus(status);

  if (flags.noSensor) {
    // s5: the quaternion is identity and means nothing. Say so; do not move the camera.
    if (!_state.noSensor) {
      _state.noSensor = true;
      _changed();
    }

    return;
  }

  if (_state.noSensor) {
    _state.noSensor = false;
    _changed();
  }

  if (_state.aligning) {
    _collect(q);

    return;
  }

  _drive(q);
}

/*
 * THE PUCK CONFIRMS ITS OWN ALIGNMENT: double-tap it (PROTOCOL.md s6, event 0x02).
 *
 * Reaching for the mouse is the one movement guaranteed to disturb the thing being lined up - the
 * hand holding the puck is the hand that has to let go of it. Tapping confirms without moving it,
 * and the gesture happens where the person is already looking.
 *
 * The button in the card stays as a fallback and is not decoration: a puck whose firmware predates
 * the gesture emits nothing, and somebody who cannot tap reliably still has to be able to finish.
 * Nothing here breaks if no event ever arrives.
 */
function _onEvent(decoded) {
  if (!_state.aligning || decoded?.eventName !== 'doubleTap') return;

  finishAlign();
}

/** `?puck=fake` - the whole workflow with no hardware. See `fakePuck.js` for what it does. */
function _wantsFake() {
  try {
    return new URLSearchParams(location.search).get('puck') === 'fake';
  } catch {
    return false;   // no `location` (node tests)
  }
}

/**
 * Wire the puck up and decide whether to offer it at all.
 *
 * The source is built NOW, at startup, rather than on the first click. `requestDevice()` may only
 * run while the browser is still handling a user gesture, and **an `await` spends that gesture** -
 * so anything asynchronous has to happen before the click, not inside it. The transport's own
 * `getDevices()` lookup follows the same rule for the same reason; its header has the story.
 *
 * `offered` resolving after the UI has rendered is why `EVENTS.PUCK_CHANGED` fires here: the panel
 * draws itself hidden and unhides on that.
 */
export function init() {
  const fake = _wantsFake();

  _source = fake ? fakePuck() : createPuck({ transport: createWebBluetoothTransport() });

  _source.on('state', _onState);
  _source.on('orientation', _onOrientation);
  _source.on('event', _onEvent);
  _source.on('battery', (percent) => {
    _state.battery = typeof percent === 'number' ? percent : null;
    _changed();
  });
  _source.on('batteryStatus', (status) => {
    _state.batteryStatus = status;
    _changed();
  });

  // A fake puck is offered whether or not this machine has a radio; that is the point of it.
  if (fake) {
    _state.offered = true;
    _changed();

    return;
  }

  isAvailable()
    .then((available) => {
      _state.offered = available;
      _changed();
    })
    .catch(() => {
      // An API that cannot be asked is not an API that is missing, but with no way to tell, not
      // drawing a control that cannot work is the better of two wrong answers.
      _state.offered = false;
    });
}

/**
 * Open the link. **Call this from inside a click handler, synchronously.**
 *
 * The first connect opens the browser's device chooser, which needs the user gesture intact. An
 * `await` anywhere before this call spends it, and the failure mode is a Connect button that
 * silently does nothing - which cost `mixo-ar` weeks.
 */
export function connect() {
  _source?.connect();
}

/**
 * Finish with the puck: put it to SLEEP, then drop the link.
 *
 * Otherwise "disconnect" only drops the radio and leaves the puck awake, advertising and draining
 * its cell, with nothing on screen to say so - the person has done the only thing the interface
 * offers to finish with it and it is still running.
 *
 * The sleep is best-effort and the disconnect happens either way. PROTOCOL.md s6: the device
 * answers a sleep by disconnecting itself, so the write can fail simply because it worked.
 */
export async function disconnect() {
  try {
    await _source?.sleepNow();
  } catch {
    /* Already gone, or gone because it obeyed. The next line is the same either way. */
  }

  _source?.disconnect();
}

export const PuckLink = {
  init, snapshot, connect, disconnect, beginAlign, finishAlign, cancelAlign,
};
