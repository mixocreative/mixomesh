import type { AddAction, BrushMode, EditMode, EditTool, SelectStyle, StatusMessage, StepKind, STEP_KINDS } from './types';
import { busyStatus } from './status';
import { modeExtension } from './modes';

/**
 * The command registry: every control that has a name (a button, a key) is one row here, and the
 * components and the keyboard read it instead of deciding label, hint, visibility or enabled state
 * themselves (docs/design/ui-structure.md section 5). A typed descriptor table, no generic
 * renderer. Labels, hints and reasons are i18n keys; the host translates them where they show.
 */
export const COMMAND_IDS = [
  'history.undo', 'history.redo',
  'view.models', 'view.wireframe', 'view.fit', 'view.bottom',
  'objects.selectAll', 'objects.delete',
  'transform.select', 'transform.move', 'transform.rotate',
  'project.open', 'project.save',
  'supports.generate', 'supports.clearManual', 'supports.remove', 'check.run',
  'mode.edit', 'mode.zones', 'mode.exit',
  'zones.clearAll',
  'edit.generate', 'edit.add', 'edit.remove', 'edit.dragSelect', 'edit.dragUnselect', 'edit.clearSelection', 'edit.deleteSelection',
  'setting.clickReach',
  'shape.reset', 'shape.selectCustomised',
  'export.active-printable', 'export.active-supports', 'export.separate-printable', 'export.separate-supports', 'export.whole-printable',
] as const;
/** The built-in commands. */
export type CoreCommandId = (typeof COMMAND_IDS)[number];
/** Every command id: the built-in ones and an app's own (`interface ExtraCommandIds { 'dental.next': true }`, rows via `registerCommands`). */
export type CommandId = CoreCommandId | keyof ExtraCommandIds;
/** Extension point: an app's own command ids. */
export interface ExtraCommandIds {}

/** `primary` is the red fill (one per view), `destructive` the danger outline; the button reads both. */
export type Role = 'primary' | 'secondary' | 'destructive';

/** What the registry's rules read, built by the host from its own state; an app mode adds (optional) fields by augmenting it. */
export interface UiState {
  mode: EditMode;
  /** There is an active object. */
  active: boolean;
  /** Triangles of the active object when it is too heavy for hand edits. */
  heavy: number | undefined;
  /** Objects on the plate. */
  units: number;
  /** Name of the active object. */
  activeName: string | undefined;
  /** Some object on the plate has supports. */
  supported: boolean;
  /** No-support zones painted on the active object. */
  zones: number;
  /** An export is running. */
  exporting: boolean;
  /** Objects selected in the left panel. */
  selectedObjects: number;
  /** Support Edit Mode's tool, and under Add whether a click adds or removes. */
  tool: EditTool;
  addAction: AddAction;
  /** Under Select: Click or Drag over. */
  method: SelectStyle;
  /** What Drag over does now: the Select | Unselect switch, flipped while Shift is held. */
  dragAction: BrushMode;
  /** Supports selected in Support Edit Mode. */
  selection: number;
  /** Supports of the active object with settings of their own, and how many of the selected ones. */
  customisedActive: number;
  customisedSelected: number;
  /** Customised supports across the objects the header count speaks of, and how many of them sit on objects other than the active one. */
  customisedTargeted: number;
  customisedOthers: number;
  /** The active object has supports (generated or hand-added). */
  activeSupported: boolean;
  /** Undo and Redo as the host can run them now (Undo stops at the mode's floor). */
  canUndo: boolean;
  canRedo: boolean;
  /** What the step Undo would take back, and the step Redo would bring back, named by kind. */
  undoStep: StepKind | undefined;
  redoStep: StepKind | undefined;
  modelsVisible: boolean;
  wireframe: boolean;
  /** Every object in scope has supports, so the one generate action reads Regenerate. */
  generated: boolean;
  /** A placement job is running: Generate waits for it. */
  generating: boolean;
}

/** One row of the registry: what a control shows and does, as functions of the `UiState`. */
export interface Command {
  role: Role;
  /**
   * The key that runs it, as "Ctrl+Shift+Z" or "Esc": the one source of the key text in hints and
   * key caps. keys.ts binds it, and commands.test.ts checks the two agree.
   */
  shortcut?: string | ((s: UiState) => string | undefined);
  /** i18n keys, translated where shown; the shortcut is added to the hint. */
  label(s: UiState): string;
  hint(s: UiState): string;
  /** Values for `{n}` placeholders in the hint. */
  hintVars?(s: UiState): Record<string, string | number> | undefined;
  visible(s: UiState): boolean;
  enabled(s: UiState): boolean;
  /** Why the control is off; defined exactly when a visible command is not enabled. */
  disabledReason(s: UiState): StatusMessage | undefined;
  pressed?(s: UiState): boolean;
  /** The command a press runs, when it is another one: the exit buttons all run `mode.exit`. */
  runs?(s: UiState): CommandId;
}

const UNDO_HINTS: Record<(typeof STEP_KINDS)[number], string> = {
  addObjects: 'Undo the import', deleteObjects: 'Undo deleting objects', generate: 'Undo generating supports', removeSupports: 'Undo removing the supports',
  clearManual: 'Undo clearing manual edits', addSupport: 'Undo adding a support', deleteSupports: 'Undo deleting supports', zones: 'Undo the zone change', move: 'Undo moving the object', settings: 'Undo the settings change', openProject: 'Undo opening the project',
};
const REDO_HINTS: Record<(typeof STEP_KINDS)[number], string> = {
  addObjects: 'Redo the import', deleteObjects: 'Redo deleting objects', generate: 'Redo generating supports', removeSupports: 'Redo removing the supports',
  clearManual: 'Redo clearing manual edits', addSupport: 'Redo adding a support', deleteSupports: 'Redo deleting supports', zones: 'Redo the zone change', move: 'Redo moving the object', settings: 'Redo the settings change', openProject: 'Redo opening the project',
};
/** Supports can be picked, added and deleted: Support Edit Mode, and where an app mode says so. */
const editing = (s: UiState) => s.mode === 'edit' || modeExtension(s.mode)?.uiEditsSupports?.(s) === true;
/** Where a selection of supports (or tips) can be made and deleted. */
const selecting = (s: UiState) => editing(s) || modeExtension(s.mode)?.uiSelectsTips?.(s) === true;
const editable = (s: UiState) => s.active && s.heavy === undefined;
const always = () => true;
const never = () => undefined;
/** Why a heavy active object takes no hand edits (for an app's own rows too). */
export const heavyReason = (s: UiState): StatusMessage => ({ key: 'Too detailed to edit by hand ({n} triangles). Generate and export still use the full model.', vars: { n: (s.heavy ?? 0).toLocaleString() } });
/** Why a mode button is off: no object, a heavy one, or the other mode is on. */
export const entryReason = (s: UiState): StatusMessage | undefined => {
  if (s.mode !== 'off') return busyStatus(s.mode);
  if (!s.active) return { key: 'Select an object first.' };
  return s.heavy === undefined ? undefined : heavyReason(s);
};
const inMode = (mode: EditMode) => (s: UiState) => s.mode === mode;
const noModelReason: StatusMessage = { key: 'Import a model first.' };
/** Why a control waits while supports are generated. */
export const generatingReason: StatusMessage = { key: 'Supports are being generated: wait for it to finish.' };

/** The undo and redo hints of a step kind. */
const stepHint = (kind: StepKind, hints: Readonly<Record<string, string>>, own: 'undo' | 'redo'): string => hints[kind] ?? extraStepHints.get(kind)?.[own] ?? (own === 'undo' ? 'Undo' : 'Redo');

export const COMMANDS: Readonly<Record<CoreCommandId, Command>> = {
  'history.undo': {
    role: 'secondary', shortcut: 'Ctrl+Z',
    label: () => 'Undo', hint: (s) => (s.undoStep ? stepHint(s.undoStep, UNDO_HINTS, 'undo') : 'Undo'),
    visible: always, enabled: (s) => s.canUndo,
    disabledReason: (s) => (s.canUndo ? undefined : { key: s.mode === 'off' ? 'Nothing to undo.' : 'Nothing to undo here: leave the mode to undo earlier steps.' }),
  },
  'history.redo': {
    role: 'secondary', shortcut: 'Ctrl+Shift+Z',
    label: () => 'Redo', hint: (s) => (s.redoStep ? stepHint(s.redoStep, REDO_HINTS, 'redo') : 'Redo'),
    visible: always, enabled: (s) => s.canRedo,
    disabledReason: (s) => (s.canRedo ? undefined : { key: 'Nothing to redo.' }),
  },
  'view.models': {
    role: 'secondary',
    label: (s) => (s.modelsVisible ? 'Hide models' : 'Show models'),
    hint: (s) => (s.modelsVisible ? 'Hide the models to see the supports alone. Export is not affected' : 'Show the models again'),
    visible: always, enabled: always, disabledReason: never,
  },
  'view.wireframe': {
    role: 'secondary',
    label: (s) => (s.wireframe ? 'Solid' : 'Wireframe'),
    hint: (s) => (s.wireframe ? 'Draw the models solid' : 'Draw the models as wireframes to see supports behind them'),
    visible: always, enabled: always, disabledReason: never,
  },
  'view.fit': {
    role: 'secondary', label: () => 'Fit view', hint: () => 'Frame the selection from the current angle',
    visible: always, enabled: (s) => s.units > 0, disabledReason: (s) => (s.units > 0 ? undefined : noModelReason),
  },
  'view.bottom': {
    role: 'secondary', label: () => 'Bottom view', hint: () => 'Look straight up at the selection to check contact points',
    visible: always, enabled: (s) => s.units > 0, disabledReason: (s) => (s.units > 0 ? undefined : noModelReason),
  },
  'objects.selectAll': {
    role: 'secondary', label: () => 'Select all', hint: () => 'Select every object',
    visible: always, enabled: (s) => s.units > 0, disabledReason: (s) => (s.units > 0 ? undefined : noModelReason),
  },
  'objects.delete': {
    role: 'destructive', shortcut: 'Delete',
    label: () => 'Delete', hint: () => 'Delete the selected objects. Undo brings them back',
    visible: always, enabled: (s) => s.selectedObjects > 0,
    disabledReason: (s) => (s.selectedObjects > 0 ? undefined : { key: 'Select an object first.' }),
  },
  'transform.select': transformChoice('Select', 'Select objects without a gizmo'),
  'transform.move': transformChoice('Move', 'Move the active object with the gizmo', 'G'),
  'transform.rotate': transformChoice('Rotate', 'Rotate the active object with the gizmo', 'R'),
  'project.open': {
    role: 'secondary', label: () => 'Open project', hint: () => 'Open a .mixosupports project. It replaces the plate; Undo brings the previous plate back',
    visible: always, enabled: (s) => s.mode === 'off', disabledReason: (s) => (s.mode === 'off' ? undefined : busyStatus(s.mode)),
  },
  'project.save': {
    role: 'secondary', label: () => 'Save project', hint: () => 'Save the plate, supports and hand edits as a .mixosupports file. Models stay on this device',
    visible: always, enabled: (s) => s.units > 0, disabledReason: (s) => (s.units > 0 ? undefined : noModelReason),
  },
  'supports.generate': {
    role: 'primary',
    label: (s) => (s.generating ? 'Generating supports…' : s.generated ? 'Regenerate' : 'Generate supports'),
    hint: (s) => (s.generated
      ? 'Replaces the automatic supports. Supports you added are kept, and so are removals where they still fit'
      : 'Place automatic supports on the selected objects, or on every object when none is selected'),
    visible: always, enabled: (s) => s.units > 0 && !s.generating,
    disabledReason: (s) => (s.units === 0 ? { key: 'Import a model before generating supports.' } : s.generating ? generatingReason : undefined),
  },
  'supports.clearManual': {
    role: 'destructive', label: () => 'Clear manual edits', hint: () => 'Remove manual supports and bring back removed automatic ones, at once. Undo brings the edits back',
    visible: always, enabled: (s) => s.units > 0, disabledReason: (s) => (s.units > 0 ? undefined : noModelReason),
  },
  'supports.remove': {
    role: 'destructive', label: () => 'Remove supports', hint: () => 'Remove the supports of the selected objects. Models and manual edits are kept. Undo brings them back',
    visible: always, enabled: (s) => s.supported, disabledReason: (s) => (s.supported ? undefined : { key: 'No supports to remove.' }),
  },
  'check.run': {
    role: 'secondary', label: () => 'Check for unsupported spots', hint: () => 'Finds islands and overhangs no contact reaches, before you print.',
    visible: always, enabled: (s) => s.supported, disabledReason: (s) => (s.supported ? undefined : { key: 'Generate supports before checking them.' }),
  },
  'mode.edit': {
    role: 'secondary',
    shortcut: (s) => (s.mode === 'edit' ? 'Esc' : undefined),
    label: (s) => (s.mode === 'edit' ? 'Exit Support Edit Mode' : 'Edit supports'),
    hint: (s) => (s.mode === 'edit' ? 'Finish editing supports' : s.activeName === undefined ? 'Add or remove supports by clicking' : 'Edit the supports of {name}: add or remove them by clicking'),
    hintVars: (s) => (s.mode === 'edit' || s.activeName === undefined ? undefined : { name: s.activeName }),
    visible: always,
    // Inside Support Edit Mode the button is its exit, in the same place.
    enabled: (s) => (s.mode === 'edit' ? true : s.mode === 'off' && editable(s)),
    disabledReason: (s) => (s.mode === 'edit' || (s.mode === 'off' && editable(s)) ? undefined : entryReason(s)),
    pressed: inMode('edit'),
    runs: (s) => (s.mode === 'edit' ? 'mode.exit' : 'mode.edit'),
  },
  'mode.zones': {
    role: 'secondary',
    shortcut: (s) => (s.mode === 'zones' ? 'Esc' : undefined),
    label: (s) => (s.mode === 'zones' ? 'Exit no-support zones' : 'No-support zones'),
    hint: (s) => (s.mode === 'zones' ? 'Finish painting zones' : s.activeName === undefined ? 'Paint areas of the model where automatic supports must not grow' : 'Paint no-support zones on {name}, where automatic supports must not grow'),
    hintVars: (s) => (s.mode === 'zones' || s.activeName === undefined ? undefined : { name: s.activeName }),
    visible: always,
    enabled: (s) => (s.mode === 'zones' ? true : s.mode === 'off' && editable(s)),
    disabledReason: (s) => (s.mode === 'zones' || (s.mode === 'off' && editable(s)) ? undefined : entryReason(s)),
    pressed: inMode('zones'),
    runs: (s) => (s.mode === 'zones' ? 'mode.exit' : 'mode.zones'),
  },
  /** The one exit of both modes: the Done button of each bar, both left Exit buttons, Esc and Enter. */
  'mode.exit': {
    role: 'primary', shortcut: 'Esc',
    label: () => 'Done',
    hint: (s) => (s.mode === 'zones' ? 'Finish painting zones' : 'Finish editing supports'),
    visible: (s) => s.mode !== 'off', enabled: always, disabledReason: never,
  },
  'zones.clearAll': {
    role: 'destructive', label: () => 'Clear all zones', hint: () => 'Clear every no-support zone of this object at once. Undo brings them back',
    visible: (s) => s.mode === 'zones', enabled: (s) => s.zones > 0, disabledReason: (s) => (s.zones > 0 ? undefined : { key: 'No zones are painted yet.' }),
  },
  'edit.generate': {
    role: 'secondary',
    label: (s) => (s.generating ? 'Generating supports…' : 'Generate supports'),
    hint: () => 'Place automatic supports on this object without leaving the mode',
    visible: (s) => editing(s) && !s.activeSupported, enabled: (s) => !s.generating,
    disabledReason: (s) => (s.generating ? generatingReason : undefined),
  },
  'edit.add': addChoice('add', 'Add', 'Each click adds a support on the model'),
  'edit.remove': addChoice('remove', 'Remove', 'Each click removes the support it hits, or the one nearest a click on the model within Click reach. Right-click does the same'),
  'edit.dragSelect': dragChoice('select', 'Select', 'Dragging adds supports to the selection'),
  'edit.dragUnselect': dragChoice('unselect', 'Unselect', 'Dragging takes supports out of the selection'),
  /** A number field, set through its input: the Add bar and the right panel's Advanced render this one row. */
  'setting.clickReach': {
    role: 'secondary',
    label: () => 'Click reach',
    hint: () => 'How far from a support a click may land and still pick it. Only that one support is removed',
    visible: always, enabled: (s) => s.active,
    disabledReason: (s) => (s.active ? undefined : { key: 'Select an object first.' }),
  },
  /** Support shape region: the selection follows the defaults again. */
  'shape.reset': {
    role: 'secondary',
    label: () => 'Reset to defaults',
    hint: () => 'Give the selected supports the default settings again. Undo brings their own values back',
    visible: (s) => editing(s) && s.selection > 0, enabled: (s) => s.customisedSelected > 0,
    disabledReason: (s) => (s.customisedSelected > 0 ? undefined : { key: 'None of the selected supports has settings of its own.' }),
  },
  /** The header count's action: outside Support Edit Mode it enters the mode with those supports selected. The mode edits one object: the active one, or when it has none, the first selected object that does (made active). */
  'shape.selectCustomised': {
    role: 'secondary',
    label: () => 'Select them',
    hint: (s) => (s.mode === 'edit'
      ? 'Select the supports of this object that have settings of their own'
      : s.customisedActive === 0 && s.customisedOthers > 0
        ? 'Enter Support Edit Mode on the first selected object that has supports with settings of their own, with those supports selected'
        : s.customisedOthers > 0
          ? 'Enter Support Edit Mode with the supports of the active object that have settings of their own selected. {n} more on the other selected objects: edit them one at a time'
          : 'Enter Support Edit Mode with the supports that have settings of their own selected'),
    hintVars: (s) => (s.mode !== 'edit' && s.customisedActive > 0 && s.customisedOthers > 0 ? { n: s.customisedOthers } : undefined),
    visible: (s) => s.customisedTargeted > 0, enabled: (s) => s.active && (s.mode === 'edit' ? s.customisedActive > 0 : s.mode === 'off' && (s.customisedActive > 0 ? s.heavy === undefined : s.customisedOthers > 0)),
    disabledReason: (s) => (s.mode === 'zones' ? busyStatus(s.mode) : !s.active ? { key: 'Select an object first.' } : s.mode === 'off' && s.heavy !== undefined ? heavyReason(s) : undefined),
  },
  'edit.clearSelection': {
    role: 'secondary', shortcut: 'Esc',
    label: () => 'Clear selection', hint: () => 'Unselect every support at once. Undo on the notice brings the selection back',
    visible: (s) => selecting(s) && s.selection > 0, enabled: always, disabledReason: never,
  },
  'edit.deleteSelection': {
    role: 'destructive', shortcut: 'Delete',
    label: () => 'Delete', hint: () => 'Delete the selected supports. Undo brings them back',
    visible: selecting, enabled: (s) => s.selection > 0, disabledReason: (s) => (s.selection > 0 ? undefined : { key: 'Select a support first.' }),
  },
  'export.active-printable': exportRow('Active object with model', 'One STL file: the active object and its supports'),
  'export.active-supports': exportRow('Active object, supports only', 'One STL file: only the supports of the active object'),
  'export.separate-printable': exportRow('Each object with model', 'One STL file per object, each with its supports'),
  'export.separate-supports': exportRow('Each object, supports only', 'One STL file per object, supports only'),
  'export.whole-printable': exportRow('Whole plate in one file', 'One STL file: every object and its supports, as placed on the plate'),
};

/** One of the Export STL buttons: off with no model on the plate, and while an export runs. */
function exportRow(label: string, hint: string): Command {
  return {
    role: 'secondary', label: () => label, hint: () => hint,
    visible: always, enabled: (s) => s.units > 0 && !s.exporting,
    disabledReason: (s) => (s.units === 0 ? noModelReason : s.exporting ? { key: 'An export is running: wait for it to finish.' } : undefined),
  };
}

/** The Add | Remove switch under the Add tool. */
function addChoice(action: AddAction, label: string, hint: string): Command {
  return {
    role: 'secondary', label: () => label, hint: () => hint,
    visible: (s) => editing(s) && s.tool === 'add', enabled: always, disabledReason: never,
    pressed: (s) => s.addAction === action,
  };
}

/** The Select | Unselect switch under Drag over; it shows what a stroke does now, Shift included. */
function dragChoice(action: BrushMode, label: string, hint: string): Command {
  return {
    role: 'secondary', label: () => label, hint: () => hint,
    visible: (s) => selecting(s) && s.tool === 'select' && s.method === 'brush', enabled: always, disabledReason: never,
    pressed: (s) => s.dragAction === action,
  };
}

/** The gizmo choices of the Transform group: live outside the modes, with an object to move. */
function transformChoice(label: string, hint: string, shortcut?: string): Command {
  return {
    role: 'secondary', ...(shortcut ? { shortcut } : {}),
    label: () => label, hint: () => hint,
    visible: always, enabled: (s) => s.mode === 'off' && s.active,
    disabledReason: (s) => (s.mode !== 'off' ? busyStatus(s.mode) : s.active ? undefined : { key: 'Select an object first.' }),
  };
}

/** A command as it stands in one state: what a control shows and does. */
export interface ResolvedCommand {
  id: CommandId;
  role: Role;
  shortcut: string | undefined;
  label: string;
  hint: string;
  hintVars: Record<string, string | number> | undefined;
  visible: boolean;
  enabled: boolean;
  disabledReason: StatusMessage | undefined;
  /** Defined for a two-state button (the mode buttons): its aria-pressed. */
  pressed: boolean | undefined;
  /** The command a press runs (the id itself, or `mode.exit` for an exit button). */
  runs: CommandId;
}

const extraCommands = new Map<CommandId, Command>();
const extraStepHints = new Map<StepKind, { undo: string; redo: string }>();

/** Adds an app's command rows (ids from `ExtraCommandIds`); returns the call that removes them again (tests). */
export function registerCommands(rows: Partial<Record<CommandId, Command>>): () => void {
  const added = Object.entries(rows) as [CommandId, Command][];
  for (const [id] of added) if (id in COMMANDS || extraCommands.has(id)) throw new Error(`command '${id}' is already defined`);
  for (const [id, row] of added) extraCommands.set(id, row);
  return () => { for (const [id, row] of added) if (extraCommands.get(id) === row) extraCommands.delete(id); };
}

/** Names an app's own step kinds (`ExtraStepKinds`) in Undo and Redo hints; returns the call that removes them. */
export function registerStepHints(hints: Partial<Record<StepKind, { undo: string; redo: string }>>): () => void {
  const added = Object.entries(hints) as [StepKind, { undo: string; redo: string }][];
  for (const [kind, hint] of added) extraStepHints.set(kind, hint);
  return () => { for (const [kind, hint] of added) if (extraStepHints.get(kind) === hint) extraStepHints.delete(kind); };
}

/** Every command id: the built-in ones in their order, then the app's in registration order. */
export function commandIds(): readonly CommandId[] {
  return extraCommands.size === 0 ? COMMAND_IDS : [...COMMAND_IDS, ...extraCommands.keys()];
}

/** The row of `id`; throws for an id nothing defines. */
export function commandOf(id: CommandId): Command {
  const command = (COMMANDS as Partial<Record<CommandId, Command>>)[id] ?? extraCommands.get(id);
  if (!command) throw new Error(`unknown command '${id}'`);
  return command;
}

export function resolve(id: CommandId, state: UiState): ResolvedCommand {
  const command = commandOf(id);
  const { shortcut } = command;
  return {
    id, role: command.role, shortcut: typeof shortcut === 'function' ? shortcut(state) : shortcut,
    label: command.label(state), hint: command.hint(state), hintVars: command.hintVars?.(state),
    visible: command.visible(state), enabled: command.enabled(state), disabledReason: command.disabledReason(state),
    pressed: command.pressed?.(state),
    runs: command.runs?.(state) ?? id,
  };
}
