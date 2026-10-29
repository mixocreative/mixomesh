/**
 * Support Edit Mode (Blender `mixo.support_place`): click the model to add a contact;
 * right-click or Ctrl+click a support, or the model near one, to remove it.
 * `zones` paints no-support zones on the active object's surface instead.
 * An app adds its own modes: augment `ExtraEditModes` and register them (modes.ts).
 */
export type EditMode = 'off' | 'edit' | 'zones' | keyof ExtraEditModes;
/** Extension point: app modes by id (`interface ExtraEditModes { dental: true }`). */
export interface ExtraEditModes {}
/**
 * Support Edit Mode tool: Add supports clicks the model to add; Select supports picks supports to act on.
 * An app mode adds its own tools by augmenting `ExtraEditTools` (and lists them in its `tools`).
 */
export type EditTool = 'add' | 'select' | keyof ExtraEditTools;
/** Extension point: app tools by id (`interface ExtraEditTools { paint: true }`). */
export interface ExtraEditTools {}
/** Add supports: a click adds a support, or (Remove) removes the one it hits: the touch path of the right-click. */
export type AddAction = 'add' | 'remove';
/** Select supports: Click picks one support at a time; Drag over (the brush) paints a selection. */
export type SelectStyle = 'click' | 'brush';
/** Drag over adds supports to the selection or takes them out of it. */
export type BrushMode = 'select' | 'unselect';
/** The zone brush paints no-support zones or erases them. */
export type ZoneKind = 'paint' | 'erase';

/** What one history step did, in the words Undo and Redo name it by. */
export const STEP_KINDS = ['addObjects', 'deleteObjects', 'generate', 'removeSupports', 'clearManual', 'addSupport', 'deleteSupports', 'zones', 'move', 'settings', 'openProject'] as const;
/** An app's own step kinds (`interface ExtraStepKinds { dentalArea: true }`), named with `registerStepHints` (commands.ts). */
export interface ExtraStepKinds {}
/** A history step's kind: a built-in one or an app's (`ExtraStepKinds`). */
export type StepKind = (typeof STEP_KINDS)[number] | keyof ExtraStepKinds;

/**
 * A status line as an i18n key and its values, so the host translates it (and re-translates it
 * when the language changes); `other` is the plural key picked when `vars.n` is not 1.
 */
export interface StatusMessage {
  key: string;
  vars?: Record<string, string | number>;
  other?: string;
  /** A second sentence, joined to the first when shown. */
  then?: StatusMessage;
}
