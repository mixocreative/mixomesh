import type { Brush } from './brushScheduler';
import { gestureOwner, modeExtension } from './modes';
import { effectiveBrushMode } from './selection';
import type { EditSession } from './session';
import type { BrushMode, EditMode, ZoneKind } from './types';

/**
 * What a press or a drag on the canvas does now: nothing special outside the modes, the zone brush
 * while painting zones, and in Support Edit Mode one of its three ways of working (Add supports;
 * Select supports by Click, `pick`; Select supports by Drag over, `drag`, with the circle).
 */
export type Gesture = CoreGesture | ExtraGestures[keyof ExtraGestures];

/** Extension point: an app mode's own gestures (`interface ExtraGestures { dental: DentalGesture }`), listed in its `gestureKinds`. */
export interface ExtraGestures {}

/** The gestures of the built-in modes (off, zones, Support Edit Mode). */
export type CoreGesture =
  | { kind: 'none' }
  | { kind: 'zones'; brush: { radius: number; kind: ZoneKind } }
  /** `remove`: a click removes the support it hits instead of adding one. */
  | { kind: 'add'; remove: boolean }
  | { kind: 'pick' }
  /** `brush.mode` is what a stroke does now: the switch (`base`) flipped while Shift is down (`flipped`). `sizing`: the circle's size slider is held or was just moved. */
  | { kind: 'drag'; brush: Brush; base: BrushMode; flipped: boolean; sizing: boolean };

/** A Support Edit Mode gesture: Add supports, or Select supports by Click (`pick`) or Drag over (`drag`). */
export type EditGesture = Extract<Gesture, { kind: 'add' | 'pick' | 'drag' }>;

/** The `kind` tag of any gesture, built-in or an app mode's. */
export type GestureKind = Gesture['kind'];

/** The gesture the canvas acts on: an app mode may hand the canvas another one (an Edit Mode tool inside a step). */
export function canvasGesture(press: Gesture): Gesture {
  return gestureOwner(press.kind)?.canvasGesture?.(press) ?? press;
}

/** The Support Edit Mode gesture of the session's tool; `forceAdd`: Add never removes (a mode without Remove). */
export function editGesture(session: EditSession, forceAdd = false): EditGesture {
  if (session.tool === 'add') return { kind: 'add', remove: !forceAdd && session.addAction === 'remove' };
  return session.selectStyle === 'click' ? { kind: 'pick' } : { kind: 'drag', brush: { radius: session.brushRadius, mode: effectiveBrushMode(session.brushMode, session.shiftHeld) }, base: session.brushMode, flipped: session.shiftHeld, sizing: session.brushSizing };
}

/** The gesture of the session's mode and tool now; an app mode answers through its `gesture` (else none). */
export function gesture(session: EditSession): Gesture {
  switch (session.mode) {
    case 'off': return { kind: 'none' };
    case 'zones': return { kind: 'zones', brush: { radius: session.zoneRadius, kind: session.zoneKind } };
    case 'edit':
      return editGesture(session);
    default:
      return modeExtension(session.mode)?.gesture?.(session) ?? { kind: 'none' };
  }
}

/** The mode a gesture belongs to. */
export function gestureMode(gesture: Gesture): EditMode {
  return gesture.kind === 'none' ? 'off' : gesture.kind === 'zones' ? 'zones' : gestureOwner(gesture.kind)?.id ?? 'edit';
}
