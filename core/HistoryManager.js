import { EVENTS } from './events.js';
import { dispatch, withoutDirty } from './StateManager.js';

const STACK_LIMIT = 200;

let _undoStack = [];
let _redoStack = [];
let _batchLabel = null;
let _batchCmds = [];

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
  command.execute();
  if (_batchLabel !== null) {
    _batchCmds.push(command);
    return;
  }
  _undoStack.push(command);
  if (_undoStack.length > STACK_LIMIT) _undoStack.shift();
  _redoStack = [];
  dispatch(EVENTS.HISTORY_PUSHED, { label: command.label });
}

/** Undo the most recent command. Does not mark project dirty. */
export function undo() {
  if (!_undoStack.length) return;
  const cmd = _undoStack.pop();
  withoutDirty(() => cmd.undo());
  _redoStack.push(cmd);
  dispatch(EVENTS.HISTORY_UNDONE, { label: cmd.label });
}

/** Redo the most recently undone command. Does not mark project dirty. */
export function redo() {
  if (!_redoStack.length) return;
  const cmd = _redoStack.pop();
  withoutDirty(() => cmd.execute());
  _undoStack.push(cmd);
  dispatch(EVENTS.HISTORY_REDONE, { label: cmd.label });
}

/** Clear both stacks (called on new/load project). */
export function clear() {
  _undoStack = [];
  _redoStack = [];
  _batchLabel = null;
  _batchCmds = [];
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
  const batch = new BatchCommand(_batchLabel, [..._batchCmds]);
  _batchLabel = null;
  _batchCmds = [];
  _undoStack.push(batch);
  if (_undoStack.length > STACK_LIMIT) _undoStack.shift();
  _redoStack = [];
  dispatch(EVENTS.HISTORY_PUSHED, { label: batch.label });
}

export const HistoryManager = { push, undo, redo, clear, getUndoLabel, getRedoLabel, beginBatch, endBatch };

// ── Standard command classes ─────────────────────────────

export class TransformCommand {
  constructor(meshIds, prevTransforms, nextTransforms) {
    this.label = 'Transform';
    this._meshIds = meshIds;
    this._prev = prevTransforms;
    this._next = nextTransforms;
  }
  execute() {}
  undo()    {}
}

export class ShaderAssignCommand {
  constructor(meshIds, prevShaderIds, nextShaderId) {
    this.label = 'Assign Shader';
    this._meshIds = meshIds;
    this._prev = prevShaderIds;
    this._next = nextShaderId;
  }
  execute() {}
  undo()    {}
}

export class ShaderUpdateCommand {
  constructor(shaderId, field, prevValue, nextValue) {
    this.label = 'Update Shader';
    this._id = shaderId;
    this._field = field;
    this._prev = prevValue;
    this._next = nextValue;
  }
  execute() {}
  undo()    {}
}

export class ShaderDuplicateCommand {
  constructor(shaderId, newShaderId) {
    this.label = 'Duplicate Shader';
    this._id = shaderId;
    this._newId = newShaderId;
  }
  execute() {}
  undo()    {}
}

export class ShaderDeleteCommand {
  constructor(shaderId, shaderEntry) {
    this.label = 'Delete Shader';
    this._id = shaderId;
    this._entry = shaderEntry;
  }
  execute() {}
  undo()    {}
}

export class UVOverrideCommand {
  constructor(meshId, prevOverride, nextOverride) {
    this.label = 'UV Override';
    this._meshId = meshId;
    this._prev = prevOverride;
    this._next = nextOverride;
  }
  execute() {}
  undo()    {}
}

export class ColorApplyCommand {
  constructor(shaderId, prevColor, nextColor) {
    this.label = 'Apply Color';
    this._id = shaderId;
    this._prev = prevColor;
    this._next = nextColor;
  }
  execute() {}
  undo()    {}
}

export class GroupCommand {
  constructor(groupId, meshIds) {
    this.label = 'Group';
    this._groupId = groupId;
    this._meshIds = meshIds;
  }
  execute() {}
  undo()    {}
}

export class UngroupCommand {
  constructor(groupId, memberIds, groupData) {
    this.label = 'Ungroup';
    this._groupId = groupId;
    this._memberIds = memberIds;
    this._groupData = groupData;
  }
  execute() {}
  undo()    {}
}

export class VisibilityCommand {
  constructor(meshIds, prevVisible, nextVisible) {
    this.label = 'Set Visibility';
    this._meshIds = meshIds;
    this._prev = prevVisible;
    this._next = nextVisible;
  }
  execute() {}
  undo()    {}
}

export class LockCommand {
  constructor(meshIds, prevLocked, nextLocked) {
    this.label = 'Set Lock';
    this._meshIds = meshIds;
    this._prev = prevLocked;
    this._next = nextLocked;
  }
  execute() {}
  undo()    {}
}

export class RenameCommand {
  constructor(objectId, prevName, nextName) {
    this.label = 'Rename';
    this._id = objectId;
    this._prev = prevName;
    this._next = nextName;
  }
  execute() {}
  undo()    {}
}

export class DeleteCommand {
  constructor(meshIds, meshData) {
    this.label = 'Delete';
    this._meshIds = meshIds;
    this._data = meshData;
  }
  execute() {}
  undo()    {}
}

export class DuplicateCommand {
  constructor(meshIds, newMeshIds) {
    this.label = 'Duplicate';
    this._meshIds = meshIds;
    this._newIds = newMeshIds;
  }
  execute() {}
  undo()    {}
}

export class SmartReplaceCommand {
  constructor(meshId, newAssetId, prevAssetId) {
    this.label = 'Smart Replace';
    this._meshId = meshId;
    this._newAsset = newAssetId;
    this._prevAsset = prevAssetId;
  }
  execute() {}
  undo()    {}
}

export class TransformSwabCommand {
  constructor(meshIdA, meshIdB, prevTransformA, prevTransformB) {
    this.label = 'Transform Swab';
    this._idA = meshIdA;
    this._idB = meshIdB;
    this._prevA = prevTransformA;
    this._prevB = prevTransformB;
  }
  execute() {}
  undo()    {}
}
