// Undo/redo stack machinery. Command classes live in src/core/commands/*
// (TransformCommands / HierarchyCommands / ShaderCommands / ScaleCommands,
// shared helpers in support.js) and are re-exported below so existing
// importers keep working — `import { push, TransformCommand } from
// './HistoryManager.js'` is unchanged (review L29 / Blueprint §0.5 split).

import { EVENTS } from './events.js';
import { dispatch, withoutDirty } from './StateManager.js';

export * from './commands/TransformCommands.js';
export * from './commands/HierarchyCommands.js';
export * from './commands/ShaderCommands.js';
export * from './commands/ScaleCommands.js';

const STACK_LIMIT = 200;

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
}

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
    if (_undoStack.length > STACK_LIMIT) _undoStack.shift();
    _redoStack = [];
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
  if (_undoStack.length > STACK_LIMIT) _undoStack.shift();
  _redoStack = [];
  dispatch(EVENTS.HISTORY_PUSHED, { label: batch.label });
}

export const HistoryManager = {
  push, undo, redo, clear, getUndoLabel, getRedoLabel, beginBatch, endBatch,
  getPosition, isApplying,
};
