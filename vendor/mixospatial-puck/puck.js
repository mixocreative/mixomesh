// The puck as a *source*: `connect()`, `disconnect()`, `on(event, handler)`. Nothing above this
// file knows a radio was involved, and nothing in it knows what a turn means.
//
// It owns three jobs and no others:
//
//   1. the link's state machine, including bounded reconnection
//   2. handing each notification to `codec.js` and **counting what it refuses** (PROTOCOL.md s8)
//   3. the one command the device still has, `sleepNow()`
//
// The zero is **not** here. Decision 0006 puts `q_zero` in the host, because without a
// magnetometer the puck's yaw restarts at an arbitrary angle on every wake, so a stored zero would
// be valid for tilt only and the device could never know its own zero had gone meaningless. The
// consumer applies `q_zero⁻¹ · q`; mixo-ar's `puck-orientation.js` is a worked example.
//
// The transport is handed in rather than created here, because it is not the same in the two places
// this has to run: a browser tab needs a click handler for the chooser, Electron needs a
// `select-bluetooth-device` handler in the main process, and the test suite needs neither. See
// `transport-web-bluetooth.js` for the real one and `fake-transport.js` for the one that replays
// the fixtures.

import {
  OPCODE_SLEEP_NOW,
  bytesToHex,
  commandRejection,
  decodeBatteryLevel,
  decodeBatteryStatus,
  decodeEvent,
  decodeOrientation,
  droppedSince,
  encodeCommand,
} from './codec.js';

/**
 * How long to wait before each reconnection attempt, and — by its length — how many there are.
 *
 * Bounded on purpose. `gatt.connect()` needs no user gesture and a pending call waits for a
 * connectable advertisement, which is what makes "pick it up and the page has it" feel like magic.
 * But a pending connect is **not** a guarantee: it can reject, it can time out, and the host OS
 * Bluetooth stack has a say too. A single hopeful promise would leave a page showing "connecting"
 * for ever, so the loop is finite and its end is a state the person can see.
 */
export const RETRY_DELAYS_MS = Object.freeze([500, 1500, 4000, 10000]);

/**
 * The i18n key handed to the consumer with a `lost` state.
 *
 * It is a **key, not a sentence**: the consumer owns the languages. This is the one key mixo-ar's
 * panel already carries, and it is deliberately the same for every kind of unintended loss —
 * because a panel that blanks its status line on an unknown key is worse than a panel that says
 * "the link dropped" when the specific cause was a refused connect. The specific cause travels in
 * the third argument, which a consumer may ignore and the demo displays.
 */
export const LOST_REASON_KEY = 'puckLostReason';

/** A fresh counter set. Everything a person may need to be shown about a lossy link. */
function freshDiagnostics() {
  return {
    /** `"orientation:wrong-length"` → how many. Keyed this way so the panel can list it as is. */
    rejected: {},
    rejectedTotal: 0,
    /** The most recent refusal, with its bytes: the one thing that makes a reject debuggable. */
    lastReject: null,
    /** Notifications missing, by `seq`, per stream. The only evidence BLE ever gives (s5). */
    dropped: { orientation: 0, events: 0 },
    /** Unknown event id → how many. Accepted and counted, never dropped (s6). */
    surfaced: {},
    surfacedTotal: 0,
    accepted: { orientation: 0, events: 0 },
  };
}

/**
 * Build a puck source over a transport.
 *
 * `schedule` exists so the tests do not wait in real time; it defaults to `setTimeout` and nothing
 * else in this file reaches for a clock.
 */
export function createPuck({
  transport,
  retryDelaysMs = RETRY_DELAYS_MS,
  schedule = (fn, ms) => setTimeout(fn, ms),
} = {}) {
  if (!transport) {
    throw new Error('createPuck needs a transport; see transport-web-bluetooth.js or fake-transport.js');
  }

  const handlers = new Map();
  const diagnostics = freshDiagnostics();

  let link = 'idle';
  /** Set while we are the ones closing the link, so the close is reported as `idle`, not `lost`. */
  let closingDeliberately = false;
  let attempt = 0;
  let retryTimer = null;
  let lastOrientationSeq = null;
  let lastEventSeq = null;
  let battery = null;
  let batteryStatus = null;

  const emit = (event, ...args) => {
    for (const handler of handlers.get(event) || []) {
      handler(...args);
    }
  };

  const setLink = (next, detail) => {
    link = next;

    // `lost` always carries the same key; `idle`, `connecting` and `connected` carry none, because
    // the consumer already has a sentence for each of those from the state itself.
    if (next === 'lost') {
      emit('state', next, LOST_REASON_KEY, detail);
    } else {
      emit('state', next);
    }
  };

  const countReject = (characteristic, result, bytes) => {
    const key = `${characteristic}:${result.reason}`;

    diagnostics.rejected[key] = (diagnostics.rejected[key] || 0) + 1;
    diagnostics.rejectedTotal += 1;
    diagnostics.lastReject = {
      characteristic,
      reason: result.reason,
      hex: bytesToHex(bytes),
      length: result.length,
    };

    // Section 8: a discarded packet must be surfaced, not `console.warn`-ed and not returned from
    // silently. Emitting it is this library's half of that; displaying it is the consumer's.
    emit('diagnostics', diagnostics);
  };

  const onOrientationBytes = (bytes) => {
    const decoded = decodeOrientation(bytes);

    if (!decoded.ok) {
      countReject('orientation', decoded, bytes);
      return;
    }

    const missed = droppedSince(lastOrientationSeq, decoded.seq);

    lastOrientationSeq = decoded.seq;
    diagnostics.accepted.orientation += 1;

    if (missed > 0) {
      diagnostics.dropped.orientation += missed;
      emit('diagnostics', diagnostics);
    }

    // `status` is the raw byte *and* `flags` is it decoded, so a consumer with its own bit reader
    // (mixo-ar has one) does not have to reassemble the byte from booleans.
    emit('orientation', {
      q: decoded.q,
      status: decoded.status,
      flags: decoded.flags,
      seq: decoded.seq,
      at: Date.now(),
    });
  };

  const onEventBytes = (bytes) => {
    const decoded = decodeEvent(bytes);

    if (!decoded.ok) {
      countReject('events', decoded, bytes);
      return;
    }

    const missed = droppedSince(lastEventSeq, decoded.seq);

    lastEventSeq = decoded.seq;
    diagnostics.accepted.events += 1;

    if (missed > 0) {
      diagnostics.dropped.events += missed;
    }

    if (!decoded.known) {
      // A newer firmware learned a gesture. Accepted, counted, shown — never silently ignored,
      // which would be a feature that appears not to work with nothing saying why (s6).
      diagnostics.surfaced[decoded.event] = (diagnostics.surfaced[decoded.event] || 0) + 1;
      diagnostics.surfacedTotal += 1;
    }

    if (missed > 0 || !decoded.known) {
      emit('diagnostics', diagnostics);
    }

    emit('event', decoded);
  };

  /**
   * The optional status characteristic: is a cell fitted, is it charging.
   *
   * `null` in, `null` out - a puck without the characteristic says nothing, and nothing is a
   * valid answer that the page renders as "unknown" rather than as "no". Never counted as a
   * rejection, because not having an optional characteristic is not a protocol violation.
   */
  const onBatteryStatusBytes = (bytes) => {
    if (bytes === null) {
      batteryStatus = null;
      emit('batteryStatus', null);

      return;
    }

    const decoded = decodeBatteryStatus(bytes);

    if (!decoded.ok) {
      batteryStatus = null;
      emit('batteryStatus', null);

      return;
    }

    batteryStatus = {
      present: decoded.present,
      charging: decoded.charging,
      wiredPower: decoded.wiredPower,
    };

    emit('batteryStatus', batteryStatus);
  };

  const onBatteryBytes = (bytes) => {
    // `null` is how the transport says the read itself failed. Section 4: until a measurement
    // passes the device's own plausibility check nothing is notified and a read fails with ATT
    // 0x80, which means *no plausible reading yet* — so the answer is "unknown", never 0 %.
    //
    // Web Bluetooth does not expose the ATT code to a page at all (it arrives as a DOMException
    // whose message is the only hint), so every failed read is treated as unknown. That is safe
    // here because the only other reason a read fails is a link that has gone, which the link
    // state already reports.
    if (bytes === null || bytes === undefined) {
      battery = null;
      emit('battery', null);
      return;
    }

    const decoded = decodeBatteryLevel(bytes);

    if (!decoded.ok) {
      countReject('battery', decoded, bytes);
      battery = null;
      emit('battery', null);
      return;
    }

    battery = decoded.percent;
    emit('battery', decoded.percent);
  };

  const onClosed = (cause) => {
    stopRetrying();

    if (closingDeliberately) {
      closingDeliberately = false;
      setLink('idle');
      return;
    }

    // Everything else is unintended as far as the person is concerned — including the puck's own
    // idle timeout, which is the device's choice and not theirs. So the view freezes rather than
    // resetting (decision 0009), and the retry loop keeps a standing connect open: movement wakes
    // the puck, it advertises again, and the link reforms without anybody pressing anything.
    setLink('lost', { cause: cause || 'closed' });
    scheduleRetry();
  };

  const transportHandlers = {
    orientation: onOrientationBytes,
    event: onEventBytes,
    battery: onBatteryBytes,
    batteryStatus: onBatteryStatusBytes,
    closed: onClosed,
  };

  function stopRetrying() {
    if (retryTimer !== null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  }

  function scheduleRetry() {
    if (attempt >= retryDelaysMs.length) {
      // The end of the loop is a state, not a silence: the panel still says "lost", and the only
      // way back is the person asking again.
      emit('diagnostics', diagnostics);
      return;
    }

    const delay = retryDelaysMs[attempt];

    attempt += 1;
    retryTimer = schedule(() => {
      retryTimer = null;
      open(true);
    }, delay);
  }

  async function open(isRetry) {
    setLink('connecting');

    try {
      // A chooser needs a user gesture; `gatt.connect()` on a device we already have does not.
      // That difference is the transport's to keep, which is why reopening is its own call.
      if (isRetry && typeof transport.reopen === 'function') {
        await transport.reopen(transportHandlers);
      } else {
        await transport.open(transportHandlers);
      }
    } catch (failure) {
      // A failed connect must be visible. The alternative — leaving a spinner up — is what makes a
      // silent macOS Bluetooth permission denial look like a broken page.
      setLink('lost', { cause: isRetry ? 'reconnect-failed' : 'connect-failed', error: failure });
      scheduleRetry();
      return;
    }

    attempt = 0;
    lastOrientationSeq = null;
    lastEventSeq = null;
    setLink('connected');
  }

  return {
    /** `state` · `orientation` · `event` · `battery` · `batteryStatus` · `diagnostics`. */
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) || []), handler]);
    },

    /** Call from a click handler: the first connect may open the browser's device chooser. */
    connect() {
      if (link === 'connecting' || link === 'connected') {
        return;
      }

      stopRetrying();
      attempt = 0;
      closingDeliberately = false;

      return open(false);
    },

    /** The person says they are finished. Reported as `idle`, and nothing retries after it. */
    disconnect() {
      stopRetrying();
      attempt = retryDelaysMs.length;

      if (link === 'idle') {
        return;
      }

      closingDeliberately = true;
      transport.close();

      // Read this twice: the flag was just set, so the test below looks vacuous and is not. A
      // transport that calls `closed()` **synchronously** has already reported `idle` and cleared
      // it, and this branch is skipped. It runs only for a transport that never calls back — an
      // already-dead link — which must still leave the panel where the person put it.
      if (closingDeliberately) {
        closingDeliberately = false;
        setLink('idle');
      }
    },

    /**
     * Ask the puck to sleep now (opcode `0x02`, write **with response**).
     *
     * Resolves `{ ok: true }`, or `{ ok: false, reason }`. A write that was silently dropped would
     * leave a page believing the puck is asleep while it is still draining the cell, which is why
     * the protocol insists on the response.
     */
    async sleepNow() {
      const bytes = encodeCommand(OPCODE_SLEEP_NOW);
      const wouldRefuse = commandRejection(bytes);

      if (wouldRefuse) {
        // Unreachable unless this library and the spec have drifted; the test asserts it cannot
        // happen, and it is cheaper to check than to debug a device that refuses our own frame.
        return { ok: false, reason: wouldRefuse.reason, attError: wouldRefuse.attError };
      }

      // The puck disconnects straight after obeying, so that close is ours, not a dropped link.
      closingDeliberately = true;

      try {
        await transport.write(bytes);
        return { ok: true };
      } catch (failure) {
        closingDeliberately = false;
        return { ok: false, reason: 'write-failed', error: failure };
      }
    },

    /** Read-only views, for a consumer that renders on its own clock rather than on our events. */
    get link() {
      return link;
    },

    get batteryStatus() {
      return batteryStatus;
    },

    get battery() {
      return battery;
    },

    get diagnostics() {
      return diagnostics;
    },
  };
}
