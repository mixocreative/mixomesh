import type { SupportContact } from '../host/core/supports/mesh';
import { bindInitialSession, modeExtension, modeOwnedTool, editModes, type SessionKit, type SessionView } from './modes';
import { paintSelection, pruneSelection, toggleSelection } from './selection';
import type { AddAction, BrushMode, EditMode, EditTool, SelectStyle, ZoneKind } from './types';

/**
 * The editing session of the active object: which mode is on, its tools and the selected
 * supports. View state only, never in the undo history; the host keeps the undo floor (history)
 * and sets it when `startsEditing` says a mode was entered from outside. An app mode adds its own
 * fields by augmenting this interface and naming their values in its `initial` (modes.ts).
 */
export interface EditSession {
  mode: EditMode;
  /** The object the session belongs to (the scene's active object). */
  activeUnitId: string | undefined;
  /** Triangles of the active object when it is heavy: it takes no hand edits (Edit Mode, zones). */
  heavy: number | undefined;
  tool: EditTool;
  /** Under the Add tool: a click adds or removes. */
  addAction: AddAction;
  selectStyle: SelectStyle;
  /** The Select | Unselect switch's own choice; it outlasts the modes. Shift flips it only while held (`shiftHeld`, the latest `shiftKey` the brush saw). */
  brushMode: BrushMode;
  /** Shift is down: Drag over does the other of Select and Unselect (editing/selection effectiveBrushMode). */
  shiftHeld: boolean;
  /** Drag over circle radius in screen px (slider 8–80, step 4): a view setting, so the object's Remove radius stays untouched. */
  brushRadius: number;
  /** The Circle size slider is held or was just moved: the view previews the circle (viewport/CirclePreview). */
  brushSizing: boolean;
  zoneKind: ZoneKind;
  /** Zone brush radius in mm. */
  zoneRadius: number;
  /** Selected contact ids of the active object. */
  selection: ReadonlySet<string>;
}

const NO_SELECTION: ReadonlySet<string> = new Set();

/** The session before anything happened; a registered mode's `initial` fields are merged into it. */
export const initialSession: EditSession = {
  mode: 'off',
  activeUnitId: undefined,
  heavy: undefined,
  tool: 'add',
  addAction: 'add',
  selectStyle: 'click',
  brushMode: 'select',
  shiftHeld: false,
  brushRadius: 24,
  brushSizing: false,
  zoneKind: 'paint',
  zoneRadius: 2,
  selection: NO_SELECTION,
} satisfies Partial<EditSession> as EditSession;

bindInitialSession((fields, remove) => {
  const target = initialSession as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (remove) delete target[key];
    else target[key] = value;
  }
});

/** What Fix on a check finding sets: the Add tool with its click adding (a Remove left on would take supports away). */
export const FIX_TOOL_EVENTS: readonly SessionEvent[] = [{ type: 'setTool', tool: 'add' }, { type: 'setAddAction', action: 'add' }];

/**
 * `enterEdit` and `enterZones` start a mode from outside the modes, only for an active object that
 * takes hand edits (the modes never switch directly: exit first). `exit` is the one user exit from
 * either mode (Done, the left Exit button, Esc, Enter); `leave` ends any mode without a word (Remove supports, a check's Fix);
 * `activeUnitChanged` (with the triangles of a heavy object) and `contactsChanged` follow the scene.
 */
export type SessionEvent = CoreSessionEvent | ExtraSessionEvents[keyof ExtraSessionEvents];

/** Extension point: an app mode's own events (`interface ExtraSessionEvents { dental: DentalEvent }`), reduced by its `reduce`. */
export interface ExtraSessionEvents {}

export type CoreSessionEvent =
  | { type: 'enterEdit' }
  | { type: 'enterZones' }
  | { type: 'exit' }
  | { type: 'leave' }
  | { type: 'activeUnitChanged'; id: string | undefined; heavy?: number | undefined }
  | { type: 'contactsChanged'; contacts: readonly SupportContact[] }
  | { type: 'setTool'; tool: EditTool }
  | { type: 'setAddAction'; action: AddAction }
  | { type: 'setSelectStyle'; style: SelectStyle }
  | { type: 'setBrushMode'; mode: BrushMode }
  | { type: 'shift'; held: boolean }
  | { type: 'setBrushRadius'; radius: number }
  | { type: 'setBrushSizing'; sizing: boolean }
  | { type: 'setZoneKind'; kind: ZoneKind }
  | { type: 'setZoneRadius'; radius: number }
  | { type: 'toggleContact'; id: string }
  | { type: 'paint'; ids: readonly string[]; mode: BrushMode }
  | { type: 'clearSelection' }
  /** Undo of a cleared selection: exactly these ids again. */
  | { type: 'restoreSelection'; ids: readonly string[] };

/** The selection empties on every mode change; a tool only one mode offers falls back to Add. */
function withMode(state: EditSession, mode: EditMode): EditSession {
  if (mode === state.mode) return state;
  return { ...state, mode, shiftHeld: false, selection: NO_SELECTION, tool: modeOwnedTool(state.tool) ? 'add' : state.tool };
}

function withSelection(state: EditSession, selection: ReadonlySet<string>): EditSession {
  return selection === state.selection ? state : { ...state, selection };
}

function set<K extends keyof EditSession>(state: EditSession, key: K, value: EditSession[K]): EditSession {
  return state[key] === value ? state : { ...state, [key]: value };
}

/** The next session; the same object when the event changes nothing. */
export function reduceSession(state: EditSession, event: SessionEvent): EditSession {
  switch (event.type) {
    case 'enterEdit':
      return state.mode === 'off' && editable(state) ? withMode(state, 'edit') : state;
    case 'enterZones':
      return state.mode === 'off' && editable(state) ? withMode(state, 'zones') : state;
    case 'exit':
    case 'leave':
      return withMode(state, 'off');
    case 'activeUnitChanged':
      if (event.id === state.activeUnitId) return set(state, 'heavy', event.heavy);
      // A mode belongs to the active object: it ends when that object goes (delete, undo).
      return { ...state, activeUnitId: event.id, heavy: event.heavy, mode: event.id ? state.mode : 'off', selection: NO_SELECTION };
    case 'contactsChanged':
      // Ids that no longer exist (undo, regeneration) drop out.
      return withSelection(state, pruneSelection(state.selection, event.contacts));
    case 'setTool': return set(state, 'tool', event.tool);
    case 'setAddAction': return set(state, 'addAction', event.action);
    case 'setSelectStyle': return set(state, 'selectStyle', event.style);
    case 'setBrushMode':
      return set(state, 'brushMode', event.mode);
    case 'shift': return selectsTips(state) ? set(state, 'shiftHeld', event.held) : state;
    case 'setBrushRadius': return set(state, 'brushRadius', event.radius);
    case 'setBrushSizing': return set(state, 'brushSizing', event.sizing);
    case 'setZoneKind': return set(state, 'zoneKind', event.kind);
    case 'setZoneRadius': return set(state, 'zoneRadius', event.radius);
    case 'toggleContact':
      return selectsTips(state) ? withSelection(state, toggleSelection(state.selection, event.id)) : state;
    case 'paint':
      return selectsTips(state) ? withSelection(state, paintSelection(state.selection, event.ids, event.mode)) : state;
    case 'restoreSelection':
      return selectsTips(state) ? withSelection(state, new Set(event.ids)) : state;
    case 'clearSelection':
      return withSelection(state, state.selection.size === 0 ? state.selection : NO_SELECTION);
    default:
      return reduceModeEvent(state, event);
  }
}

const KIT: SessionKit = { withMode, set, emptySelection: NO_SELECTION };

/** An app mode's own event: the first registered mode that reduces it decides; unknown events change nothing. */
function reduceModeEvent(state: EditSession, event: SessionEvent): EditSession {
  for (const mode of editModes()) {
    const next = mode.reduce?.(state, event, KIT);
    if (next) return next;
  }
  return state;
}

/** Supports can be picked, added and deleted: Support Edit Mode, and where an app mode says so. */
export function editsSupports(state: SessionView): boolean {
  return state.mode === 'edit' || modeExtension(state.mode)?.editsSupports?.(state) === true;
}

/** Tips can be selected: where supports can be edited, and where an app mode says so. */
export function selectsTips(state: SessionView): boolean {
  return editsSupports(state) || modeExtension(state.mode)?.selectsTips?.(state) === true;
}

/** There is an active object and it takes hand edits (it is not heavy). */
export function editable(state: EditSession): boolean {
  return state.activeUnitId !== undefined && state.heavy === undefined;
}

/** The step entered a mode from outside (the host may set an undo floor for it). */
export function startsEditing(previous: EditSession, next: EditSession): boolean {
  return previous.mode === 'off' && next.mode !== 'off';
}
