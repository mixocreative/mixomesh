// Undo/redo stack machinery. Command classes live in src/core/commands/*
// (TransformCommands / HierarchyCommands / ParentCommands / ShaderCommands /
// ScaleCommands, shared helpers in support.js) and are re-exported below so existing
// importers keep working — `import { push, TransformCommand } from
// './HistoryManager.js'` is unchanged (review L29 / Blueprint §0.5 split).

import { EVENTS } from './events.js';
import { dispatch, withoutDirty } from './StateManager.js';
import { caps } from './storage/capabilities.js';
import { t } from '../i18n/index.js';

export * from './commands/TransformCommands.js';
export * from './commands/HierarchyCommands.js';
export * from './commands/ParentCommands.js';
export * from './commands/ShaderCommands.js';
export * from './commands/ScaleCommands.js';
export * from './commands/PlacementCommands.js';
export * from './commands/BooleanCommands.js';
export * from './commands/SliceConnectorCommands.js';
export * from './commands/AssetCommands.js';
export * from './commands/PrinterCommands.js';
export * from './commands/RefinementCommands.js';

const STACK_LIMIT = 200;

// Heavy-mesh spec §4 — history never pins a big mesh forever. Commands that
// keep meshes alive for undo/redo expose
//   retainedTriangles(side) → triangles held only for that side
//   release(side)           → free them, the entry is gone for good
// where side 'undo' = the entry sits on the undo stack (it was executed) and
// 'redo' = on the redo stack (it was undone). An entry leaving the 200-step
// window or a dropped redo branch is released; the undo side's retained total
// is also capped at the tier's triangle budget (oldest entries go first, the
// newest always stays undoable).
let _retainCap = null;   // null = caps.triangleBudget

let _undoStack = [];
let _redoStack = [];
let _batchLabel = null;
let _batchCmds  = [];
let _serial    = 0;      // monotonic command id — drives position-based dirty (§5)
let _applying  = false;  // true while push/undo/redo runs (incl. its events)

// ── Batch command ────────────────────────────────────────
class BatchCommand {
  constructor(label, commands) {
    this.label = label;
    this._commands = commands;
  }
  execute() { this._commands.forEach(c => c.execute()); }
  undo()    { [...this._commands].reverse().forEach(c => c.undo()); }
  retainedTriangles(side) { return this._commands.reduce((n, c) => n + _retained(c, side), 0); }
  release(side) { for (const c of this._commands) _release(c, side); }
}

function _retained(cmd, side) {
  try { return cmd?.retainedTriangles?.(side) ?? 0; }
  catch (err) {
    // Unknown size counts as over any cap, so the trim releases it (and every
    // older step) instead of pinning its meshes for the session.
    console.error('History retainedTriangles failed:', err);
    return Number.POSITIVE_INFINITY;
  }
}

function _release(cmd, side) {
  try { cmd?.release?.(side); } catch (err) { console.error('History release failed:', err); }
}

function _dropRedo() {
  for (const cmd of _redoStack) _release(cmd, 'redo');
  _redoStack = [];
}

function _trimUndo() {
  while (_undoStack.length > STACK_LIMIT) _release(_undoStack.shift(), 'undo');
  const cap = _retainCap ?? caps.triangleBudget;
  if (!(cap > 0)) return;
  const held = _undoStack.map(cmd => _retained(cmd, 'undo'));
  let excess = held.reduce((a, b) => a + b, 0) - cap;
  // A released step cannot be undone through, so everything older goes with
  // it. Cut after the last entry that must be released for the rest to fit;
  // steps that hold nothing are kept, since dropping them frees nothing.
  let cut = 0;
  for (let i = 0; excess > 0 && i < _undoStack.length - 1; i++) {
    if (held[i] > 0) { excess -= held[i]; cut = i + 1; }
  }
  if (!cut) return;
  for (const cmd of _undoStack.splice(0, cut)) _release(cmd, 'undo');
  // Never drop an undo step silently (review M5).
  dispatch(EVENTS.TOAST, { message: t('toast.undoTrimmed'), type: 'info', duration: 6000 });
}

/** Test seam: override the retained-triangle cap (null = tier budget). */
export function setRetainCap(cap) { _retainCap = cap; }

// ── Public API ───────────────────────────────────────────

/**
 * Execute a command, add to undo stack, clear redo.
 * During an open batch, collects into the batch instead.
 * @param {{ label: string, execute(): void, undo(): void }} command
 */
export function push(command) {
  _applying = true;
  try {
    command.execute();
    if (_batchLabel !== null) {
      _batchCmds.push(command);
      return;
    }
    command._serial = ++_serial;
    _undoStack.push(command);
    _dropRedo();
    _trimUndo();
    dispatch(EVENTS.HISTORY_PUSHED, { label: command.label });
  } finally {
    _applying = false;
  }
}

/** Undo the most recent command. Dirty is derived from getPosition() (§5). */
export function undo() {
  if (!_undoStack.length) return;
  _applying = true;
  try {
    const cmd = _undoStack.pop();
    withoutDirty(() => cmd.undo());
    _redoStack.push(cmd);
    dispatch(EVENTS.HISTORY_UNDONE, { label: cmd.label });
  } finally {
    _applying = false;
  }
}

/** Redo the most recently undone command. Dirty is derived from getPosition(). */
export function redo() {
  if (!_redoStack.length) return;
  _applying = true;
  try {
    const cmd = _redoStack.pop();
    withoutDirty(() => cmd.execute());
    _undoStack.push(cmd);
    _trimUndo();
    dispatch(EVENTS.HISTORY_REDONE, { label: cmd.label });
  } finally {
    _applying = false;
  }
}

/**
 * Serial of the undo-stack top (0 when empty). Uniquely identifies the state
 * version reachable via undo/redo — PersistenceManager compares it against
 * the position recorded at save to derive dirty (Blueprint §5).
 */
export function getPosition() {
  return _undoStack.length ? (_undoStack[_undoStack.length - 1]._serial ?? 0) : 0;
}

/** True while a command (push/undo/redo) is executing, incl. its events. */
export function isApplying() {
  return _applying;
}

/** Clear both stacks (called on new/load project). */
export function clear() {
  _undoStack = [];
  _redoStack = [];
  _batchLabel = null;
  _batchCmds  = [];
}

/** @returns {string|null} */
export function getUndoLabel() {
  return _undoStack.length ? _undoStack[_undoStack.length - 1].label : null;
}

/** @returns {string|null} */
export function getRedoLabel() {
  return _redoStack.length ? _redoStack[_redoStack.length - 1].label : null;
}

/** Start collecting commands into a named batch. */
export function beginBatch(label) {
  _batchLabel = label;
  _batchCmds = [];
}

/** Close the batch and push it as a single undo entry. */
export function endBatch() {
  if (_batchLabel === null) return;
  const label = _batchLabel;
  const cmds = [..._batchCmds];
  _batchLabel = null;
  _batchCmds = [];
  if (!cmds.length) return;   // empty batch → no undo entry (review L24)
  const batch = new BatchCommand(label, cmds);
  batch._serial = ++_serial;
  _undoStack.push(batch);
  _dropRedo();
  _trimUndo();
  dispatch(EVENTS.HISTORY_PUSHED, { label: batch.label });
}

export const HistoryManager = {
  push, undo, redo, clear, getUndoLabel, getRedoLabel, beginBatch, endBatch,
  getPosition, isApplying, setRetainCap,
};
