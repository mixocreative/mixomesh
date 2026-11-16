// The radio, and only the radio: `navigator.bluetooth` in, byte arrays out.
//
// Everything the browser imposes lives here, so that `puck.js` stays testable in Node and the two
// places this has to run can differ without the state machine knowing:
//
//   - **a chooser needs a user gesture.** `requestDevice()` must be called from inside a click
//     handler. `gatt.connect()` has no such requirement, which is why `reopen()` exists and is the
//     thing the reconnect loop uses.
//   - **GATT objects do not survive a disconnect.** The service and every characteristic are
//     re-fetched on each open. Holding them across a reconnect is the classic silent failure here.
//   - **a failed read tells you almost nothing.** Web Bluetooth does not hand a page the ATT error
//     code, so PROTOCOL.md's `0x80` ("no plausible reading yet") arrives as a DOMException with a
//     message. Battery therefore reports *unknown* on any failure — see `puck.js` for why that is
//     safe rather than lossy.
//
// Electron needs one thing this file does not do: a `select-bluetooth-device` handler in the main
// process. That is the app's to add, and it is the reason the transport is injected at all.

export const PUCK_SERVICE = '7bdff800-4d3b-4a35-8a74-f2d0e125868d';
export const ORIENTATION_CHARACTERISTIC = '7bdff801-4d3b-4a35-8a74-f2d0e125868d';
export const EVENTS_CHARACTERISTIC = '7bdff802-4d3b-4a35-8a74-f2d0e125868d';
export const COMMAND_CHARACTERISTIC = '7bdff803-4d3b-4a35-8a74-f2d0e125868d';

/** The standard Battery Service. We do not invent one (PROTOCOL.md section 1). */
export const BATTERY_SERVICE = 'battery_service';
export const BATTERY_LEVEL = 'battery_level';

/**
 * Battery Level Status, `0x2BED`. Standard, and OPTIONAL in both directions.
 *
 * It carries whether a cell is fitted at all and whether it is charging - neither of which the
 * plain Battery Level can express, and both of which a page wants to draw. A puck whose firmware
 * predates it simply does not have the characteristic, and everything below treats that as
 * *unknown* rather than as a failure.
 */
export const BATTERY_LEVEL_STATUS = 0x2bed;

/**
 * Does this browser have the API at all?
 *
 * **Feature-detect; never sniff the user agent.** Web Bluetooth is Chrome, Edge, Opera and Brave on
 * the desktop: Safari does not have it on macOS and Firefox does not have it at all. A page that
 * guesses from the user agent is wrong in both directions, and an audit of mixoDental in November
 * 2026 found exactly this missing — a browser without WebGL2 rendered it as a blank white page.
 */
export function isSupported(bluetooth = globalThis.navigator?.bluetooth) {
  return Boolean(bluetooth);
}

/**
 * Is there a radio switched on?
 *
 * Separate from `isSupported` because the answers differ: the API can exist on a machine whose
 * Bluetooth is off. An API that cannot be asked counts as available, since the chooser is the next
 * thing the person sees either way.
 */
export async function isAvailable(bluetooth = globalThis.navigator?.bluetooth) {
  if (!isSupported(bluetooth)) {
    return false;
  }

  if (typeof bluetooth.getAvailability !== 'function') {
    return true;
  }

  try {
    return await bluetooth.getAvailability();
  } catch {
    return false;
  }
}

/**
 * Build the real transport.
 *
 * `namePrefix` is NOT a filter - the chooser filters on the service UUID (see below). It is only
 * used to recognise an already-authorised device from `getDevices()` on a later page load, where
 * the name is all there is to go on. PROTOCOL.md section 4 fixes the advertised name as
 * `mixo-NNN`, the number being assigned at build time so that two pucks on one desk can be told
 * apart in the chooser by a number also written on the device.
 *
 * `bluetooth` is injectable for the same reason the transport is: so a test can hand in a stub.
 */
/**
 * How long to wait for a connect before giving up on it.
 *
 * `gatt.connect()` on a device the browser REMEMBERS does not fail when that device is not there:
 * it waits, indefinitely, for a connectable advertisement that may never come. No rejection, no
 * timeout, no error - the page simply says "connecting" for ever, which is indistinguishable from
 * a slow connection and is the worst possible failure mode.
 *
 * So every connect is bounded. The reconnect state machine in puck.js is built around a promise
 * that eventually settles; without this, it never does and its bounded retries never run.
 *
 * Ten seconds because a puck that is present and advertising connects in well under one. This is
 * the "it is not coming" timeout, not the "be patient" one.
 */
const CONNECT_TIMEOUT_MS = 10000;

/** Reject after `ms` if `promise` has not settled. Does NOT cancel it - see `connectBounded`. */
function withTimeout(promise, ms, what) {
  let timer;

  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}

/**
 * Connect, bounded, and ABANDON the attempt if the bound is reached.
 *
 * The cancel is the whole point, and leaving it out is a bug this cost an evening to find.
 * Losing the race does not stop the connect underneath it: the browser is still waiting for that
 * advertisement. And Chrome COALESCES - a second `gatt.connect()` on the same device while one is
 * in flight returns the attempt already running rather than starting a fresh one. So one hung
 * connect poisons every retry after it: each one inherits the same stuck operation, times out at
 * the same bound, and `puck.js` exhausts its four tries and reports `reconnect-failed` against a
 * puck that is sitting on the desk advertising.
 *
 * `disconnect()` on a device that is only *connecting* is what actually throws that attempt away,
 * so the next try starts clean. It is the odd-looking call in this file and the one not to remove.
 */
export async function connectBounded(device, timeoutMs = CONNECT_TIMEOUT_MS) {
  try {
    return await withTimeout(device.gatt.connect(), timeoutMs, 'gatt.connect()');
  } catch (failure) {
    try {
      device.gatt.disconnect();
    } catch {
      // Already gone, or never started. Either way there is nothing left to abandon.
    }

    throw failure;
  }
}

export function createWebBluetoothTransport({
  bluetooth = globalThis.navigator?.bluetooth,
  namePrefix = 'mixo-',
} = {}) {
  let device = null;
  let handlers = null;
  let onDisconnected = null;

  /*
   * The already-authorised device, looked up NOW rather than inside the click.
   *
   * THIS IS THE WHOLE REASON THIS VARIABLE EXISTS, and moving the lookup back into `open()` breaks
   * Connect everywhere the page has not been granted a device before. `requestDevice()` may only
   * run while the browser is still handling a user gesture, and **an `await` spends that gesture**.
   * The lookup used to sit at the top of `open()`, so the sequence inside the click handler was
   *
   *     await bluetooth.getDevices()   // gesture spent here
   *     await bluetooth.requestDevice(...)   // SecurityError, no chooser ever appears
   *
   * and the thrown SecurityError was caught upstream and reported as a lost link - so the symptom
   * was a Connect button that appeared to do nothing, and a status line blaming the puck's battery.
   * It hid for weeks because the only browser profile anyone tested had already been granted the
   * device, in which case `getDevices()` found it and `requestDevice` was never reached.
   *
   * Started at construction, which is page load: by the time anybody clicks, it has long settled,
   * so the shortcut is kept and `open()` reaches `requestDevice` with the gesture intact.
   */
  let remembered = null;

  if (typeof bluetooth?.getDevices === 'function') {
    bluetooth
      .getDevices()
      .then((known) => {
        remembered = known.find((candidate) => candidate.name?.startsWith(namePrefix)) || null;
      })
      .catch(() => {
        // Not in every stable Chrome, and permission-dependent. The chooser is what always works.
      });
  }

  const forget = () => {
    if (device && onDisconnected) {
      device.removeEventListener('gattserverdisconnected', onDisconnected);
    }

    onDisconnected = null;
  };

  /** Everything after "we have a device": the half that must happen again on every reconnect. */
  const attach = async (next) => {
    handlers = next;

    forget();

    onDisconnected = () => {
      // `gattserverdisconnected` carries **no reason** — which is precisely why PROTOCOL.md section
      // 6 sends a `sleeping` event before a deliberate disconnect. Its absence proves nothing, so
      // an unexplained drop is reported as unexplained.
      handlers.closed('gattserverdisconnected');
    };

    device.addEventListener('gattserverdisconnected', onDisconnected);

    const server = await connectBounded(device);
    const service = await server.getPrimaryService(PUCK_SERVICE);

    const subscribe = async (uuid, deliver) => {
      const characteristic = await service.getCharacteristic(uuid);

      characteristic.addEventListener('characteristicvaluechanged', (change) => {
        deliver(change.target.value);
      });

      await characteristic.startNotifications();

      return characteristic;
    };

    await subscribe(ORIENTATION_CHARACTERISTIC, (value) => handlers.orientation(value));
    await subscribe(EVENTS_CHARACTERISTIC, (value) => handlers.event(value));

    await attachBattery(server);
  };

  /**
   * The standard Battery Service, treated as optional on purpose.
   *
   * A puck whose battery characteristic is missing or unreadable is still a working puck, so a
   * failure here must not fail the connect — it reports unknown and the orientation stream lives.
   */
  const attachBattery = async (server) => {
    try {
      const service = await server.getPrimaryService(BATTERY_SERVICE);
      const level = await service.getCharacteristic(BATTERY_LEVEL);

      level.addEventListener('characteristicvaluechanged', (change) => {
        handlers.battery(change.target.value);
      });

      try {
        await level.startNotifications();
      } catch {
        // Notify is optional on some stacks; a read still works.
      }

      handlers.battery(await level.readValue());

      /*
       * The status characteristic, separately and forgivingly.
       *
       * Its own try/catch because it is optional: older firmware does not have it, and a puck
       * that reports a perfectly good percentage must not be treated as broken for lacking the
       * extra. A failure here leaves charging and "is a cell fitted" unknown, which is what the
       * page draws when it has not been told.
       */
      try {
        const status = await service.getCharacteristic(BATTERY_LEVEL_STATUS);

        status.addEventListener('characteristicvaluechanged', (change) => {
          handlers.batteryStatus(change.target.value);
        });

        try {
          await status.startNotifications();
        } catch {
          // Same as above: notify is optional, a read still works.
        }

        handlers.batteryStatus(await status.readValue());
      } catch {
        handlers.batteryStatus(null);
      }
    } catch {
      // Section 4: a read that fails means "no plausible reading yet", and the only honest answer
      // a client can give is unknown. Never 0 %.
      handlers.battery(null);
    }
  };

  return {
    name: 'web bluetooth',

    /** Must be called from a user gesture: this is the call that may open the chooser. */
    async open(next) {
      if (!isSupported(bluetooth)) {
        throw new Error('this browser has no Web Bluetooth; it needs Chrome or Edge on the desktop');
      }

      // A device we are already authorised for needs no chooser, not even on a fresh page load.
      // Read from `remembered`, which was filled at construction - NOT awaited here, because an
      // await before `requestDevice` costs the user gesture it needs. See the comment above.
      if (!device) {
        device = remembered;
      }

      if (!device) {
        device = await bluetooth.requestDevice({
          // Filter on the SERVICE, never on the name - PROTOCOL.md section 4. A name filter is
          // the obvious thing and it is wrong in both directions: it hides a puck whose name was
          // changed, and it shows anything else whose name happens to start the same way. The
          // service UUID is the thing that actually means "this is a puck".
          filters: [{ services: [PUCK_SERVICE] }],
          // Services a page does not list here are invisible to it even once connected.
          optionalServices: [PUCK_SERVICE, BATTERY_SERVICE],
        });
      }

      try {
        await attach(next);
      } catch (failure) {
        // A remembered device that would not connect is probably stale - a different address
        // after a reflash, or simply gone. Forgetting it here means the NEXT press of Connect
        // shows the chooser rather than silently retrying the same dead handle.
        device = null;
        throw failure;
      }
    },

    /** No gesture, no chooser: the reconnect path. Fails if we have never had a device. */
    async reopen(next) {
      if (!device) {
        throw new Error('nothing to reopen: no device has been chosen yet');
      }

      await attach(next);
    },

    async write(bytes) {
      const server = device?.gatt;

      if (!server?.connected) {
        throw new Error('cannot write: the puck is not connected');
      }

      const service = await server.getPrimaryService(PUCK_SERVICE);
      const characteristic = await service.getCharacteristic(COMMAND_CHARACTERISTIC);

      // **With response.** A silently dropped `sleep` would leave the page believing the puck is
      // asleep while it is still draining the cell; the response is the only evidence either way.
      await characteristic.writeValueWithResponse(bytes);
    },

    close() {
      // Drop the listener first: this disconnect is ours, and `puck.js` has already said so. Left
      // attached, it would arrive as an unexplained drop and start the reconnect loop.
      forget();

      if (device?.gatt?.connected) {
        device.gatt.disconnect();
      }

      handlers?.closed('closed-by-us');
    },

    /** The chooser remembers a device for the page session; this is how a person picks another. */
    forgetDevice() {
      forget();
      device = null;
    },
  };
}
