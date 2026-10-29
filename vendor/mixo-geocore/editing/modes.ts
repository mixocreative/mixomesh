import type { UiState } from './commands';
import type { Gesture } from './gesture';
import type { KeyAction, KeyInput } from './keys';
import type { PanelSection } from './locks';
import type { EditSession, SessionEvent } from './session';
import type { EditMode, EditTool, StatusMessage } from './types';

/*
 * Extension point: an app adds its own edit modes (mixoDental's dental steps, its paint and erase
 * area tools) without forking the session, gesture, keys, status, locks or commands modules.
 *
 * Types: augment the interfaces the modules export (TypeScript declaration merging), e.g.
 *
 *   declare module '@mixo-geocore/editing/types' { interface ExtraEditModes { dental: true } interface ExtraEditTools { paint: true } }
 *   declare module '@mixo-geocore/editing/session' { interface EditSession { dentalStage: Stage } interface ExtraSessionEvents { dental: DentalEvent } }
 *   declare module '@mixo-geocore/editing/gesture' { interface ExtraGestures { dental: DentalGesture } }
 *   declare module '@mixo-geocore/editing/commands' { interface ExtraCommandIds { 'dental.next': true } interface UiState { dentalStage?: Stage } }
 *
 * Behaviour: `registerEditMode` once at startup (before the first session is made), and the
 * command rows with `registerCommands` (commands.ts). Without a registration every module behaves
 * exactly as the generic Support Edit Mode and no-support zones.
 */

/** What a mode's reducer gets to build its next session with (the generic reducer's own helpers). */
export interface SessionKit {
  /** The session in `mode`: the selection empties, Shift is released, a mode's own tool falls back to Add. */
  withMode(state: EditSession, mode: EditMode): EditSession;
  /** The session with one field set; the same object when it already holds `value`. */
  set<K extends keyof EditSession>(state: EditSession, key: K, value: EditSession[K]): EditSession;
  /** The empty selection every mode change starts with. */
  readonly emptySelection: ReadonlySet<string>;
}

/** The part of a key press a mode's keyboard rules see besides the press itself. */
export interface KeyContext {
  /** `key` in lower case. */
  lower: string;
  /** Esc, or Enter outside an element that acts on Enter itself. */
  done: boolean;
  /** Supports or tips are selected. */
  hasSelection: boolean;
}

/** A session, or the part of one a predicate is handed (at least its mode). */
export type SessionView = Pick<EditSession, 'mode'> & Partial<EditSession>;

/**
 * One app edit mode, handed to `registerEditMode`. Only `id` is required; every hook left out means
 * the generic behaviour (see each member).
 */
export interface EditModeExtension {
  /** The mode id, added to `EditMode` by augmenting `ExtraEditModes`. */
  readonly id: EditMode;
  /** Session fields the mode owns, with their values outside the mode; merged into `initialSession`. */
  readonly initial?: Partial<EditSession>;
  /** Tools only this mode offers: every mode change (in or out of any mode) falls back to Add from one. */
  readonly tools?: readonly EditTool[];
  /** The mode's own session events (`ExtraSessionEvents`); undefined: not this mode's event. */
  reduce?(state: EditSession, event: SessionEvent, kit: SessionKit): EditSession | undefined;
  /** Supports can be picked, added and deleted in this state of the mode (the Support Edit Mode tools work). */
  editsSupports?(state: SessionView): boolean;
  /** Tips can be selected in this state of the mode (besides where `editsSupports` holds). */
  selectsTips?(state: SessionView): boolean;
  /** What a press or a drag on the canvas does in the mode. */
  gesture?(session: EditSession): Gesture;
  /** The gesture kinds (`ExtraGestures`) the mode's `gesture` returns; `gestureMode` maps them back to the mode. */
  readonly gestureKinds?: readonly string[];
  /** The gesture the canvas acts on, when it is another one (a step that hands the canvas an Edit Mode tool). */
  canvasGesture?(press: Gesture): Gesture | undefined;
  /** The status line (an i18n key) per gesture kind of the mode. */
  readonly gestureStatus?: Readonly<Record<string, string>>;
  /** The status line after the user's exit from the mode. */
  readonly exitStatus?: StatusMessage;
  /** A step inside the mode starts with its own status line (an error or result of the last step does not follow). */
  restatesStatus?(previous: EditSession, next: EditSession): boolean;
  /** Why other controls are off while the mode is on, and how to get out. */
  readonly busy?: StatusMessage;
  /** Which panel sections the mode locks (default: the left panel, as Support Edit Mode). */
  locks?(section: PanelSection): boolean;
  /** The mode's keyboard rules, after Undo/Redo; undefined: the key does nothing in the mode. */
  keys?(input: KeyInput, context: KeyContext): KeyAction | undefined;
  /** The command registry's view of `editsSupports` / `selectsTips` (it reads `UiState`, not the session). */
  uiEditsSupports?(state: UiState): boolean;
  /** The `UiState` twin of `selectsTips`. */
  uiSelectsTips?(state: UiState): boolean;
}

// The registry, one per page. Map order is registration order, which decides who reduces an
// event first (session.ts reduceModeEvent) and who owns a gesture kind.
const modes = new Map<EditMode, EditModeExtension>();
let mergeInitial: ((fields: Partial<EditSession>, remove: boolean) => void) | undefined;

/** session.ts hands the registry the way to merge a mode's fields into `initialSession`. */
export function bindInitialSession(merge: (fields: Partial<EditSession>, remove: boolean) => void): void {
  mergeInitial = merge;
  for (const mode of modes.values()) if (mode.initial) merge(mode.initial, false);
}

/** Adds an app mode; returns the call that removes it again (tests). Throws for a built-in or taken id. */
export function registerEditMode(extension: EditModeExtension): () => void {
  if (extension.id === 'off' || extension.id === 'edit' || extension.id === 'zones' || modes.has(extension.id)) {
    throw new Error(`edit mode '${extension.id}' is already defined`);
  }
  modes.set(extension.id, extension);
  if (extension.initial) mergeInitial?.(extension.initial, false);
  return () => {
    if (modes.get(extension.id) !== extension) return;
    modes.delete(extension.id);
    if (extension.initial) mergeInitial?.(extension.initial, true);
  };
}

/** The registered extension of `mode`; undefined for the built-in modes and unknown ids. */
export function modeExtension(mode: EditMode): EditModeExtension | undefined {
  return modes.size === 0 ? undefined : modes.get(mode);
}

/** Every registered mode, in registration order. */
export function editModes(): readonly EditModeExtension[] {
  return [...modes.values()];
}

/** The mode whose gesture `kind` is; undefined for the built-in gestures. */
export function gestureOwner(kind: string): EditModeExtension | undefined {
  for (const mode of modes.values()) if (mode.gestureKinds?.includes(kind)) return mode;
  return undefined;
}

/** `tool` belongs to one mode only: a mode change falls back to Add from it. */
export function modeOwnedTool(tool: EditTool): boolean {
  for (const mode of modes.values()) if (mode.tools?.includes(tool)) return true;
  return false;
}
