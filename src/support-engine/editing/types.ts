/**
 * Support Edit Mode (Blender `mixo.support_place`): click the model to add a contact;
 * right-click or Ctrl+click a support, or the model near one, to remove it.
 * `zones` paints no-support zones on the active object's surface instead.
 */
export type EditMode = 'off' | 'edit' | 'zones';
/**
 * Support Edit Mode tool: Add supports clicks the model to add; Select supports picks supports to act on.
 */
export type EditTool = 'add' | 'select';
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
export type StepKind = (typeof STEP_KINDS)[number];

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
