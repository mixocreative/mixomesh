// What the bytes mean. Nothing in this file knows a radio exists.
//
// This is the whole of PROTOCOL.md sections 5, 6 and 7 as plain functions: bytes in, a record out,
// or a refusal with the reason. It uses no browser API at all, which is why the test suite can
// hammer it in Node against `../../protocol/fixtures/` — the same files the firmware's ztest reads.
//
// The one rule to keep in mind while reading: **nothing dies silently** (PROTOCOL.md section 8).
// Every function here returns a refusal you must handle; none of them returns `undefined` and
// leaves you to guess. The counting and the showing happen in `puck.js`, which has somewhere to
// put them.

/** The only `ver` byte this file implements. A different one is refused, never guessed at. */
export const PROTOCOL_VERSION = 1;

/** Exact lengths for `ver` 1. "Exact" is the point: longer is as wrong as shorter (section 8). */
export const ORIENTATION_LENGTH = 11;
export const EVENT_LENGTH = 3;
export const COMMAND_LENGTH = 2;
export const BATTERY_LENGTH = 1;

/**
 * Quaternion components are sent as `int16` at this scale, not at the full 32767.
 *
 * A fusion step transiently produces 1.0000001, which at 32767 overflows `int16` and flips the
 * sign — a 180-degree error from a rounding artefact. PROTOCOL.md section 5 has the full reasoning.
 */
export const QUATERNION_SCALE = 16384;

// `status` bits from section 5. Bit 1 is deliberately absent: it was `uncalibrated`, it was retired
// by decision 0006, and it is **reserved for ever**. A packet with it set is refused like any other
// reserved bit, which is how an older client gets told rather than believed.
export const STATUS_STILL = 0b0001;
export const STATUS_LOW_BATTERY = 0b0100;
export const STATUS_NO_SENSOR = 0b1000;

/** Every bit this version defines. Anything outside it is reserved and MUST be zero. */
const STATUS_DEFINED = STATUS_STILL | STATUS_LOW_BATTERY | STATUS_NO_SENSOR;

/** Event ids from section 6. An id that is not here is surfaced, not dropped — see `decodeEvent`. */
export const EVENT_NAMES = Object.freeze({
  1: 'tap',
  2: 'doubleTap',
  3: 'sleeping',
});

// Command opcodes from section 7. `0x01` was re-zero; it is a hole, not a free slot, because a
// stale client sending it would mean *re-zero* while a renumbered spec would read it as *sleep*.
export const OPCODE_RETIRED_REZERO = 0x01;
export const OPCODE_SLEEP_NOW = 0x02;
// Decision 0017: ask for the link LED to stay lit while an alignment is waiting on the person.
export const OPCODE_ALIGN_HOLD = 0x03;
export const OPCODE_ALIGN_RELEASE = 0x04;

const KNOWN_OPCODES = new Set([OPCODE_SLEEP_NOW, OPCODE_ALIGN_HOLD, OPCODE_ALIGN_RELEASE]);

/** The two ATT errors section 7 distinguishes: malformed frame, versus understood and refused. */
export const ATT_INVALID_LENGTH = 0x0d;
export const ATT_APPLICATION = 0x80;

/**
 * Every refusal reason this file can produce.
 *
 * They are strings rather than numbers so that a reject counter reads as English in the panel, and
 * they match the `reason` field in `../../protocol/fixtures/*.json` exactly — that equality is what
 * the tests assert, so renaming one here without regenerating the fixtures fails the suite.
 */
export const REASONS = Object.freeze({
  wrongLength: 'wrong-length',
  unknownVersion: 'unknown-version',
  reservedBits: 'reserved-bits-set',
  retiredOpcode: 'retired-opcode',
  unknownOpcode: 'unknown-opcode',
  implausiblePercent: 'implausible-percent',
});

/** A refused packet. `ok` is false so callers branch on one field and cannot forget the reason. */
function refuse(reason, length) {
  return { ok: false, reason, length };
}

/**
 * Accept whatever shape the caller has: Web Bluetooth hands you a `DataView`, tests hand you a
 * `Uint8Array`, and a fixture hands you a hex string. Normalising here keeps that choice out of
 * every function below.
 */
export function asBytes(input) {
  if (input instanceof Uint8Array) {
    return input;
  }

  if (typeof input === 'string') {
    return hexToBytes(input);
  }

  if (input instanceof DataView) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  }

  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }

  if (input && typeof input.buffer === 'object') {
    // A typed array of some other width, or a Node Buffer.
    return new Uint8Array(input.buffer, input.byteOffset || 0, input.byteLength);
  }

  return new Uint8Array(0);
}

/** The fixtures store packets as hex, including the empty one, so this must accept `''`. */
export function hexToBytes(hex) {
  const clean = String(hex).trim();

  if (clean.length % 2 !== 0) {
    throw new Error(`hex string has an odd length: ${JSON.stringify(hex)}`);
  }

  const bytes = new Uint8Array(clean.length / 2);

  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }

  return bytes;
}

/** For the demo and for test failures: a packet is far easier to argue about as hex. */
export function bytesToHex(bytes) {
  return Array.from(asBytes(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The version rule, section 8, in the order the spec states it — and the order matters.
 *
 * An empty payload has no `ver` byte to read, so it can only be a length failure. Otherwise `ver`
 * is checked **before** the length, because the required length is a property *of the version*:
 * for a `ver` we do not implement we do not know what length to expect, so "unknown-version" is
 * the honest answer and "wrong-length" would be a guess.
 */
function checkHeader(bytes, expectedLength) {
  if (bytes.length === 0) {
    return refuse(REASONS.wrongLength, 0);
  }

  if (bytes[0] !== PROTOCOL_VERSION) {
    return refuse(REASONS.unknownVersion, bytes.length);
  }

  if (bytes.length !== expectedLength) {
    return refuse(REASONS.wrongLength, bytes.length);
  }

  return null;
}

/**
 * Decode one orientation notification (section 5).
 *
 * On success: `{ ok, seq, status, flags, q }`. `status` is the **raw byte** as well as decoded
 * `flags`, because a consumer that wants to decode it itself — mixo-ar's `readStatus` does — must
 * not have to reassemble it from booleans.
 *
 * When `flags.noSensor` is set the quaternion is identity and means nothing, but the packet is
 * still accepted: section 5 is explicit that the bit is the information, and discarding the packet
 * would throw away the only evidence of what is wrong.
 */
export function decodeOrientation(input) {
  const bytes = asBytes(input);
  const bad = checkHeader(bytes, ORIENTATION_LENGTH);

  if (bad) {
    return bad;
  }

  const status = bytes[2];

  if ((status & ~STATUS_DEFINED) !== 0) {
    // Checked rather than masked-and-ignored on purpose: forward compatibility is the `ver` byte's
    // job, so a new bit means version 2, and version 2 means both halves get told.
    return refuse(REASONS.reservedBits, bytes.length);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const component = (offset) => view.getInt16(offset, true) / QUATERNION_SCALE;

  return {
    ok: true,
    seq: bytes[1],
    status,
    flags: {
      still: (status & STATUS_STILL) !== 0,
      lowBattery: (status & STATUS_LOW_BATTERY) !== 0,
      noSensor: (status & STATUS_NO_SENSOR) !== 0,
    },
    // x, y, z, w — `w` last, matching three.js's own `Quaternion.set(x, y, z, w)`.
    q: { x: component(3), y: component(5), z: component(7), w: component(9) },
  };
}

/**
 * Decode one event notification (section 6).
 *
 * An id this version does not define is **accepted with `known: false`**, not refused. Section 6
 * forbids dropping it silently: a firmware that learns a new gesture and a client that ignores it
 * is a feature that appears not to work with nothing anywhere saying why. The caller's job is to
 * count it where a person looks.
 */
export function decodeEvent(input) {
  const bytes = asBytes(input);
  const bad = checkHeader(bytes, EVENT_LENGTH);

  if (bad) {
    return bad;
  }

  const event = bytes[2];
  const name = EVENT_NAMES[event] || null;

  return { ok: true, seq: bytes[1], event, eventName: name, known: name !== null };
}

/**
 * Decode a Battery Level read or notification (the standard characteristic, section 4).
 *
 * The device never notifies a percent it has not believed, so a value outside 0-100 means
 * something is wrong rather than something is empty — and a wrong number that looks fine is the
 * failure this whole protocol is written against. Refuse it; the caller reports *unknown*.
 */
export function decodeBatteryLevel(input) {
  const bytes = asBytes(input);

  if (bytes.length !== BATTERY_LENGTH) {
    return refuse(REASONS.wrongLength, bytes.length);
  }

  const percent = bytes[0];

  if (percent > 100) {
    return refuse(REASONS.implausiblePercent, bytes.length);
  }

  return { ok: true, percent };
}

/**
 * Decode the standard Battery Level Status characteristic, `0x2BED`.
 *
 * NOT ours and not in PROTOCOL.md on purpose. Charging state and "is a cell even fitted" are
 * exactly what this standard characteristic exists to carry, and the alternative - new bits in
 * §5's status byte - is a trap: §5 says reserved bits MUST be zero, so a client cached from
 * before the change would reject every packet rather than ignore one field. A separate
 * characteristic is additive, and a client that has never heard of it simply does not read it.
 *
 * Layout (Bluetooth SIG): `flags` u8, then `powerState` u16 little-endian, then optional fields
 * this does not need. Within `powerState`:
 *
 *     bit 0      battery present
 *     bits 1-2   wired external power   0 no, 1 yes, 2 unknown
 *     bits 5-6   charge state           0 unknown, 1 charging, 2 discharging, 3 idle
 *
 * `present: false` is the honest answer for a bench board with empty battery pads, and the whole
 * reason this characteristic is read at all - the plain Battery Level would have to answer with a
 * percentage, and any percentage would be a lie.
 */
export function decodeBatteryStatus(input) {
  const bytes = asBytes(input);

  // Three bytes is the minimum: flags plus the 16-bit power state. Later fields are optional and
  // a longer packet is a NEWER sender, not a broken one, so length is a floor and not an equality.
  if (bytes.length < 3) {
    return refuse(REASONS.wrongLength, bytes.length);
  }

  const powerState = bytes[1] | (bytes[2] << 8);
  const wired = (powerState >> 1) & 0b11;
  const charge = (powerState >> 5) & 0b11;

  return {
    ok: true,
    present: (powerState & 0b1) === 1,
    /** `null` means the device said *unknown*, which is not the same as *no*. */
    wiredPower: wired === 2 ? null : wired === 1,
    charging: charge === 0 ? null : charge === 1,
  };
}

/**
 * Build an orientation packet (section 5).
 *
 * **The device is what really does this.** It is here for the fake puck and for the tests, where it
 * earns its place: encoding a fixture's own values and getting that fixture's bytes back is a much
 * stronger statement than decoding alone, because a decoder with a mirrored mistake — a swapped
 * axis pair, say — passes a decode-only test and fails this one.
 */
export function encodeOrientation(q, { seq = 0, status = 0 } = {}) {
  const bytes = new Uint8Array(ORIENTATION_LENGTH);
  const view = new DataView(bytes.buffer);

  bytes[0] = PROTOCOL_VERSION;
  bytes[1] = seq & 0xff;
  bytes[2] = status;

  // Clamped because a fusion step transiently produces 1.0000001, and at this scale that is still
  // inside `int16` — but a caller handing in a non-unit quaternion should not be able to wrap it.
  const put = (offset, value) => {
    const scaled = Math.round(value * QUATERNION_SCALE);

    view.setInt16(offset, Math.max(-32768, Math.min(32767, scaled)), true);
  };

  put(3, q.x);
  put(5, q.y);
  put(7, q.z);
  put(9, q.w);

  return bytes;
}

/** Build an event packet (section 6). Same reason as above: the fakes and the tests need it. */
export function encodeEvent(event, seq = 0) {
  return new Uint8Array([PROTOCOL_VERSION, seq & 0xff, event]);
}

/** Build a command frame (section 7). Two bytes: the version and one opcode. */
export function encodeCommand(opcode) {
  return new Uint8Array([PROTOCOL_VERSION, opcode]);
}

/**
 * What the **device** will do with these bytes: `null` if it will act, or the reason and the ATT
 * error it will answer with.
 *
 * This is deliberately a client-side mirror of a firmware rule, and it earns its place twice. It
 * proves our own encoder never builds a frame the device would refuse — the test asserts exactly
 * that against `command.json` — and it gives a failed write a reason in English instead of a
 * DOMException, which is all Web Bluetooth hands back.
 */
export function commandRejection(input) {
  const bytes = asBytes(input);

  if (bytes.length !== COMMAND_LENGTH) {
    // Malformed, not merely wrong: a different failure, and so a different code (section 7).
    return { reason: REASONS.wrongLength, attError: ATT_INVALID_LENGTH };
  }

  if (bytes[0] !== PROTOCOL_VERSION) {
    return { reason: REASONS.unknownVersion, attError: ATT_APPLICATION };
  }

  if (bytes[1] === OPCODE_RETIRED_REZERO) {
    return { reason: REASONS.retiredOpcode, attError: ATT_APPLICATION };
  }

  if (!KNOWN_OPCODES.has(bytes[1])) {
    return { reason: REASONS.unknownOpcode, attError: ATT_APPLICATION };
  }

  return null;
}

/**
 * How many notifications went missing between two `seq` values, counting the wrap at 255.
 *
 * BLE notifications are unacknowledged, so a gap in `seq` is the only evidence a client will ever
 * get that the stream is lossy (section 5). `previous === null` is the first packet of a link and
 * is never a gap.
 *
 * One ambiguity worth knowing rather than hiding: the same `seq` twice reads as 255 missing, and it
 * could equally be a duplicate. A single counter byte cannot tell those apart. The modulo is kept
 * because it never *under*-reports a loss, and at 50 Hz a 256-packet gap is five seconds of
 * silence — rare, but not impossible, which is exactly why it must not be rounded down to zero.
 */
export function droppedSince(previous, seq) {
  if (previous === null || previous === undefined) {
    return 0;
  }

  return (seq - previous - 1 + 256) % 256;
}
