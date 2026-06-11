// Shader / UV-override commands (split from HistoryManager.js — review L29).

import { getState, markDirty } from '../StateManager.js';
import { ShaderLibrary } from '../ShaderLibrary.js';

/**
 * Create a fresh shader. On undo the shader is deleted; on redo it is
 * recreated from the captured entry under the same id (createShader honours
 * a free requested id — review M14).
 */
export class ShaderCreateCommand {
  constructor(partial = {}) {
    this._partial = partial;
    this._newId   = null;
    this._entry   = null;
    this.label = 'New Shader';
  }
  execute() {
    const seed = (this._newId && this._entry) ? this._entry : this._partial;
    this._newId = ShaderLibrary.createShader(seed);
    this._entry = this._newId ? { ...getState().scene.shaders[this._newId] } : null;
    markDirty();
  }
  undo() {
    if (this._newId) ShaderLibrary.deleteShader(this._newId);
  }
  /** Last-created shader id; useful for UI callers that want to focus it. */
  getNewId() { return this._newId; }
}

/**
 * Assign a shader to one or more meshes. `prev` is captured per-mesh so
 * undo restores each mesh to whatever it had before — possibly null.
 */
export class ShaderAssignCommand {
  constructor(meshIds, shaderId) {
    this._meshIds  = meshIds.slice();
    this._shaderId = shaderId;
    const objects  = getState().scene.objects;
    this._prev = {};
    for (const id of this._meshIds) this._prev[id] = objects[id]?.shaderId ?? null;
    this.label = this._meshIds.length === 1 ? 'Assign Shader' : `Assign Shader (${this._meshIds.length})`;
  }
  execute() {
    for (const id of this._meshIds) ShaderLibrary.assignToMesh(this._shaderId, id);
    markDirty();
  }
  undo() {
    for (const id of this._meshIds) {
      const prev = this._prev[id];
      if (prev) ShaderLibrary.assignToMesh(prev, id);
      else ShaderLibrary.clearMeshShader(id);
    }
  }
}

/**
 * Mutate one field of a shader (name / diffuseColor / opacity / etc.).
 * The caller passes both prev and next values; we don't read prev from state
 * inside execute() to keep the BLUEPRINT contract ("capture prev before execute").
 */
export class ShaderUpdateCommand {
  constructor(shaderId, field, prevValue, nextValue) {
    this._shaderId = shaderId;
    this._field    = field;
    this._prev     = prevValue;
    this._next     = nextValue;
    this.label = `Update Shader (${field})`;
  }
  execute() {
    ShaderLibrary.updateShader(this._shaderId, this._field, this._next);
    markDirty();
  }
  undo() {
    ShaderLibrary.updateShader(this._shaderId, this._field, this._prev);
  }
}

/**
 * Duplicate an existing shader. The first execute() forwards to
 * `ShaderLibrary.duplicateShader`; redo recreates from the captured entry
 * under the SAME id (review M14).
 */
export class ShaderDuplicateCommand {
  constructor(sourceId) {
    this._sourceId = sourceId;
    this._newId    = null;
    this._entry    = null;
    this.label = 'Duplicate Shader';
  }
  execute() {
    if (this._newId && this._entry) {
      // Redo path. Material was disposed on undo; rebuild from snapshot.
      this._newId = ShaderLibrary.createShader(this._entry);
    } else {
      this._newId = ShaderLibrary.duplicateShader(this._sourceId);
      if (this._newId) this._entry = { ...getState().scene.shaders[this._newId] };
    }
    markDirty();
  }
  undo() {
    if (this._newId) ShaderLibrary.deleteShader(this._newId);
  }
  /** Last-created shader id; useful for UI callers that want to focus it. */
  getNewId() { return this._newId; }
}

/**
 * Delete a shader (only valid when no meshes are linked — the UI button must
 * gate on that). Undo recreates the shader from its captured fields.
 */
export class ShaderDeleteCommand {
  constructor(shaderId) {
    this._shaderId = shaderId;
    const sh = getState().scene.shaders[shaderId];
    this._snapshot = sh ? { ...sh } : null;
    this.label = 'Delete Shader';
  }
  execute() {
    if (!this._snapshot) return;
    if (ShaderLibrary.deleteShader(this._shaderId)) markDirty();
  }
  undo() {
    if (!this._snapshot) return;
    // createShader honours the snapshot's id (free after a delete), so the
    // shader returns under its ORIGINAL id and older stack entries
    // referencing it stay valid (review M14).
    this._shaderId = ShaderLibrary.createShader(this._snapshot);
  }
}

/**
 * Set or clear a per-mesh UV override. Pass `nextUV = null` to clear.
 * `prevUV` is whatever was in state.scene.uvOverrides at command-construction
 * time, or null when the mesh had no prior override.
 */
export class UVOverrideCommand {
  constructor(meshId, prevUV, nextUV) {
    this._meshId = meshId;
    this._prev = prevUV ? { ...prevUV } : null;
    this._next = nextUV ? { ...nextUV } : null;
    this.label = 'UV Override';
  }
  execute() {
    if (this._next) ShaderLibrary.setUVOverride(this._meshId, this._next);
    else            ShaderLibrary.clearUVOverride(this._meshId);
    markDirty();
  }
  undo() {
    if (this._prev) ShaderLibrary.setUVOverride(this._meshId, this._prev);
    else            ShaderLibrary.clearUVOverride(this._meshId);
  }
}

/**
 * Apply a swatch's hex color to a shader's diffuse. Effectively a specialised
 * ShaderUpdateCommand for 'diffuseColor', kept separate so the COLOR_APPLIED
 * event fires for swatch-drag tracking.
 */
export class ColorApplyCommand {
  constructor(shaderId, prevHex, nextHex) {
    this._shaderId = shaderId;
    this._prev = prevHex;
    this._next = nextHex;
    this.label = 'Apply Color';
  }
  execute() {
    ShaderLibrary.applySwatchColor(this._shaderId, this._next);
    markDirty();
  }
  undo() {
    if (this._prev) ShaderLibrary.applySwatchColor(this._shaderId, this._prev);
  }
}
