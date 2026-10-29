import { resolve, type CommandId, type UiState } from './commands';
import { modeExtension } from './modes';

/** The part of a key event target the keyboard rules look at (an HTMLElement satisfies it). */
export interface KeyTarget {
  /** Missing on the document itself (no element focused). */
  tagName: string;
  /** An input's type ("text" when it has none). */
  type?: string;
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}

/** Input types whose own keys are typing: the editor leaves them alone. */
const TEXT_INPUT = /^(text|number|search|email|tel|url|password)$/;
/** Input types that act on Enter themselves (open the file chooser, press the button). */
const PRESS_INPUT = /^(file|button|submit|reset|image)$/;

/**
 * Whether the focused element takes typed text (a text-like input, a text area, a select). Esc,
 * Delete and Enter there belong to the field. Range and checkbox inputs do not: they keep focus
 * after a click, and the editor's keys must still work.
 */
export function takesText(target: KeyTarget | null): boolean {
  const tag = target?.tagName ?? '';
  if (/^(TEXTAREA|SELECT)$/i.test(tag)) return true;
  return /^INPUT$/i.test(tag) && TEXT_INPUT.test((target?.type ?? 'text').toLowerCase());
}

/**
 * Whether Enter on the focused element is that element's own action (press a button, follow a
 * link, open a summary, choose a file, or a custom control: role="button" or any tabindex), so
 * the editor must not also take it as Done.
 */
export function enterActsOn(target: KeyTarget | null): boolean {
  // The document itself (no element focused) has no attributes.
  if (!target || typeof target.getAttribute !== 'function') return false;
  if (/^(BUTTON|A|SUMMARY)$/i.test(target.tagName)) return true;
  if (/^INPUT$/i.test(target.tagName) && PRESS_INPUT.test((target.type ?? '').toLowerCase())) return true;
  return target.getAttribute('role') === 'button' || target.hasAttribute('tabindex');
}

/** One key press as the editor sees it. `ctrl` is Ctrl or Cmd (meta). */
export interface KeyInput {
  key: string;
  ctrl: boolean;
  shift: boolean;
  /** The focused element (the event target), or null. */
  target: KeyTarget | null;
  /** The registry's state: the mode, the selection, and what is enabled. */
  ui: UiState;
}

/**
 * What a key press does: the registry command to run (undefined: nothing, also when the command is
 * off in this state), and whether the browser's own action is stopped. Tab is never taken: it
 * moves focus.
 */
export interface KeyAction {
  command: CommandId | undefined;
  preventDefault: boolean;
}

const NONE: KeyAction = { command: undefined, preventDefault: false };
/** A key that runs `command` (and stops the browser's own action unless `preventDefault` is false): what a mode's `keys` returns. */
export const runKey = (command: CommandId, preventDefault = true): KeyAction => ({ command, preventDefault });
const run = runKey;

/** The editor's keyboard rules, first match wins. Keys typed into a field that takes text are left alone. */
export function keyAction({ key, ctrl, shift, target, ui }: KeyInput): KeyAction {
  const action = bound({ key, ctrl, shift, target, ui });
  return action.command && !resolve(action.command, ui).enabled ? { ...action, command: undefined } : action;
}

function bound({ key, ctrl, shift, target, ui }: KeyInput): KeyAction {
  if (takesText(target)) return NONE;
  const { mode } = ui;
  const hasSelection = ui.selection > 0;
  const lower = key.toLowerCase();
  const done = key === 'Escape' || (key === 'Enter' && !enterActsOn(target));
  if (ctrl && lower === 'z') return run(shift ? 'history.redo' : 'history.undo');
  if (ctrl && lower === 'y') return run('history.redo');
  if (mode === 'zones' && done) return run('mode.exit');
  if (mode === 'edit' && hasSelection && (key === 'Delete' || key === 'Backspace')) return run('edit.deleteSelection');
  // Esc first drops the selection, then leaves the mode.
  if (mode === 'edit' && hasSelection && key === 'Escape') return run('edit.clearSelection');
  if (mode === 'edit' && done) return run('mode.exit');
  const extension = modeExtension(mode);
  if (extension?.keys) return extension.keys({ key, ctrl, shift, target, ui }, { lower, done, hasSelection }) ?? NONE;
  if (mode === 'off' && key === 'Delete') return run('objects.delete', false);
  if (mode === 'off' && lower === 'g') return run('transform.move', false);
  if (mode === 'off' && lower === 'r') return run('transform.rotate', false);
  return NONE;
}

/** The key whose hold flips Drag over's Select | Unselect (event.key). */
export const SHIFT_KEY = 'Shift';
