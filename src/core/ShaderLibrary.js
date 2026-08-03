import { EVENTS } from './events.js';
import { dispatch, setState, getState } from './StateManager.js';
import { AssetLoader } from './AssetLoader.js';
import { SceneManager } from './SceneManager.js';
import { shaderSignature } from './shaders/ShaderSignature.js';
import swatchData from '../config/swatches.json' with { type: 'json' };

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

const FALLBACK_DIFFUSE = '#cccccc';
const SILENT = { silent: true };

/**
 * Default swatch library (BLUEPRINT §10), maintained in
 * `config/swatches.json`. Grouped by `category` so the ShaderPanel can render
 * headed sections; user swatches live in `state.scene.userSwatches` and are
 * appended. Edit the JSON to add/retune palette entries — no code change.
 */
export const DEFAULT_SWATCHES = swatchData;

// Module-local: Babylon material objects keyed by shaderId. Not persisted in
// state — state holds only the JSON-serializable ShaderEntry.
const _materials = new Map();

// Module-local: per-mesh material clone for UV overrides. Keyed by meshId.
// `material` is a clone of the shared shader's material; `shaderId` is the
// shader the clone was derived from (so a shader-reassignment can dispose the
// stale clone). Both the clone material and any UV-bearing textures inside it
// are private to the mesh.
const _uvClones = new Map();

let _idCounter = 0;
function _nextShaderId() { return `sh_${Date.now().toString(36)}_${++_idCounter}`; }

// ── Color helpers ────────────────────────────────────────

function _color3ToHex(c3) {
  if (!c3) return FALLBACK_DIFFUSE;
  const r = Math.round(Math.max(0, Math.min(1, c3.r)) * 255);
  const g = Math.round(Math.max(0, Math.min(1, c3.g)) * 255);
  const b = Math.round(Math.max(0, Math.min(1, c3.b)) * 255);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function _hexToColor3(hex) {
  try { return BABYLON.Color3.FromHexString(hex); }
  catch { return BABYLON.Color3.FromHexString(FALLBACK_DIFFUSE); }
}

// ── Material introspection / construction ────────────────

function _detectType(material) {
  if (material instanceof BABYLON.PBRMaterial)                  return 'pbr';
  if (material instanceof BABYLON.PBRMetallicRoughnessMaterial) return 'pbr';
  if (material instanceof BABYLON.PBRSpecularGlossinessMaterial) return 'pbr';
  if (material.disableLighting === true)                        return 'unlit';
  return 'standard';
}

function _createBabylonMaterial(type, name, scene) {
  if (type === 'pbr') {
    const m = new BABYLON.PBRMaterial(name, scene);
    m.metallic  = 0;
    m.roughness = 0.5;
    return m;
  }
  if (type === 'unlit') {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.disableLighting = true;
    m.emissiveColor   = new BABYLON.Color3(1, 1, 1);
    return m;
  }
  return new BABYLON.StandardMaterial(name, scene);
}

function _buildEntryFromMaterial(material, importCtx = {}) {
  const type = _detectType(material);
  let diffuseColor = FALLBACK_DIFFUSE;
  let opacity = 1, roughness = 0.5, metallic = 0;

  if (type === 'pbr') {
    diffuseColor = _color3ToHex(material.albedoColor ?? material.baseColor);
    opacity      = material.alpha ?? 1;
    roughness    = material.roughness ?? 0.5;
    metallic     = material.metallic ?? 0;
  } else {
    diffuseColor = _color3ToHex(material.diffuseColor);
    opacity      = material.alpha ?? 1;
  }

  // Whatever texture the material arrived with becomes a texture asset so the
  // user can preview it, swap it onto another shader, or replace it. The
  // import context scopes texture dedupe to the source file (§10b).
  const importedTex = material.albedoTexture ?? material.baseTexture ?? material.diffuseTexture;
  const diffuseTextureAssetId = importedTex
    ? AssetLoader.registerImportedTexture(importedTex, importCtx)
    : null;

  return {
    id: _nextShaderId(),
    name: material.name || 'Material',
    type,
    diffuseColor,
    diffuseTextureAssetId,
    // Harvest the imported texture's UV transform (KHR_texture_transform-style)
    // so a non-identity offset/scale/rotation survives import + .mixo round-trip
    // instead of being reset to identity.
    uvBase: importedTex ? {
      offsetX:  Number.isFinite(importedTex.uOffset) ? importedTex.uOffset : 0,
      offsetY:  Number.isFinite(importedTex.vOffset) ? importedTex.vOffset : 0,
      scaleX:   Number.isFinite(importedTex.uScale)  ? importedTex.uScale  : 1,
      scaleY:   Number.isFinite(importedTex.vScale)  ? importedTex.vScale  : 1,
      rotation: Number.isFinite(importedTex.wAng)    ? importedTex.wAng    : 0,
    } : { offsetX: 0, offsetY: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    opacity, roughness, metallic,
    linkedMeshIds: [],
  };
}

// ── Field → material plumbing ────────────────────────────

/**
 * Apply a ShaderEntry's full field set to a Babylon material. Used both for
 * freshly-created materials and when re-anchoring after a type change.
 */
function _applyEntryToMaterial(mat, entry) {
  const t = entry.type;
  if (t === 'pbr') {
    if ('albedoColor' in mat) mat.albedoColor = _hexToColor3(entry.diffuseColor);
    if ('baseColor'   in mat) mat.baseColor   = _hexToColor3(entry.diffuseColor);
    if ('roughness'   in mat) mat.roughness   = entry.roughness;
    if ('metallic'    in mat) mat.metallic    = entry.metallic;
  } else {
    mat.diffuseColor = _hexToColor3(entry.diffuseColor);
    // Unlit (disableLighting) shows emissiveColor, not diffuseColor — drive it
    // from the chosen colour so the viewport + exported Ke aren't stuck white.
    if (mat.disableLighting && 'emissiveColor' in mat) mat.emissiveColor = _hexToColor3(entry.diffuseColor);
  }
  mat.alpha = entry.opacity;
  // hasAlpha is set when a texture wants alpha; for plain opacity we rely on alpha.
  if (entry.opacity < 1) mat.transparencyMode = BABYLON.Material.MATERIAL_ALPHABLEND;
  _applyUVToMaterial(mat, entry.uvBase);
}

/**
 * Update one field of a Babylon material in place. The state side is handled
 * by the caller; this only touches the Babylon side.
 */
function _setMaterialField(mat, field, value, type) {
  switch (field) {
    case 'name':
      mat.name = String(value ?? mat.name);
      return;

    case 'diffuseColor': {
      const c = _hexToColor3(value);
      if (type === 'pbr') {
        if ('albedoColor' in mat) mat.albedoColor = c;
        if ('baseColor'   in mat) mat.baseColor   = c;
      } else {
        mat.diffuseColor = c;
        if (mat.disableLighting && 'emissiveColor' in mat) mat.emissiveColor = c;
      }
      return;
    }

    case 'opacity': {
      const a = Math.max(0, Math.min(1, Number(value)));
      mat.alpha = a;
      mat.transparencyMode = a < 1
        ? BABYLON.Material.MATERIAL_ALPHABLEND
        : BABYLON.Material.MATERIAL_OPAQUE;
      return;
    }

    case 'roughness':
      if (type === 'pbr' && 'roughness' in mat) mat.roughness = Number(value);
      return;

    case 'metallic':
      if (type === 'pbr' && 'metallic' in mat) mat.metallic = Number(value);
      return;

    case 'uvBase':
      _applyUVToMaterial(mat, value);
      return;

    case 'diffuseTextureAssetId': {
      // Swap the texture on whichever slot the material exposes. Releasing
      // the prior texture is AssetLoader's responsibility (it knows ownership
      // and ref-count); we just point the material at the new one.
      const slot = ('albedoTexture' in mat) ? 'albedoTexture'
                 : ('baseTexture'   in mat) ? 'baseTexture'
                 : 'diffuseTexture';
      mat[slot] = value ? AssetLoader.getBabylonTexture(value) : null;
      return;
    }

    case 'type':
      // State-only. Type changes recreate the material elsewhere.
      return;
  }
}

/**
 * Push UV offset / scale / rotation onto whatever UV-bearing texture slot the
 * material exposes. A no-op for materials without a texture.
 */
function _applyUVToMaterial(mat, uv) {
  if (!mat || !uv) return;
  const tex = mat.diffuseTexture ?? mat.albedoTexture ?? mat.baseTexture;
  if (!tex) return;
  if (typeof uv.offsetX  === 'number') tex.uOffset = uv.offsetX;
  if (typeof uv.offsetY  === 'number') tex.vOffset = uv.offsetY;
  if (typeof uv.scaleX   === 'number') tex.uScale  = uv.scaleX;
  if (typeof uv.scaleY   === 'number') tex.vScale  = uv.scaleY;
  if (typeof uv.rotation === 'number') tex.wAng    = uv.rotation;
}

// Babylon's mat.clone() copies texture *pointers*, so a UV offset set on the
// clone leaks back to every mesh sharing that base material. To make per-mesh
// UV overrides truly independent, we also clone any UV-bearing texture slot.
function _cloneMaterialWithTexture(base, name) {
  const clone = base.clone(name);
  for (const slot of ['diffuseTexture', 'albedoTexture', 'baseTexture']) {
    const t = base[slot];
    if (t && typeof t.clone === 'function') {
      try {
        const ct = t.clone();
        // Full-res-lock (audit LOW #16): export resolves the full-resolution
        // source bytes via texture.metadata.mixoAssetId. Babylon's
        // Texture.clone() does not reliably carry custom `metadata`, so copy it
        // explicitly — without it a UV-override clone would fall back to GPU
        // readback (downscaled), breaking Mimaki fidelity.
        if (t.metadata && ct && !ct.metadata) ct.metadata = { ...t.metadata };
        clone[slot] = ct;
      } catch { /* clone() can throw on raw textures — leave the shared pointer */ }
    }
  }
  return clone;
}

// ── Naming ───────────────────────────────────────────────

/**
 * Return a name that doesn't collide with any existing shader. Appends `.NNN`
 * starting at .001 ('Hull_Metal' → 'Hull_Metal.001'), stripping any existing
 * numeric suffix first so 'Hull_Metal.001' becomes 'Hull_Metal.002', not '…001.001'.
 */
function _nextAvailableName(baseName) {
  const existing = new Set(Object.values(getState().scene.shaders).map(s => s.name));
  if (!existing.has(baseName)) return baseName;
  const m = /^(.+)\.(\d{3})$/.exec(baseName);
  const stem = m ? m[1] : baseName;
  for (let i = 1; i < 10000; i++) {
    const candidate = `${stem}.${String(i).padStart(3, '0')}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${stem}.${Date.now().toString(36)}`;
}

// ── Public API ───────────────────────────────────────────

/**
 * Register every unique material in an AssetContainer as a ShaderEntry.
 * When an imported material's name collides with an existing shader, the
 * shader-merge modal is opened to let the user pick a strategy per conflict
 * (Use existing / Rename / Replace — BLUEPRINT §10). Cancel/Escape defaults
 * everything to Rename.
 *
 * @param {BABYLON.AssetContainer} container
 * @param {{ sourceAssetId?: string|null, sourceFileHash?: string|null }} [importCtx]
 *   §10b texture-identity scope, threaded into texture registration/dedupe.
 * @returns {Promise<{ shaderIds: string[], byMaterial: Map<BABYLON.Material, string> }>}
 */
export async function registerFromContainer(container, importCtx = {}) {
  const conflicts = _findNameConflicts(container, importCtx);
  const choices = conflicts.length ? await _promptMergeChoices(conflicts) : {};
  return _doRegister(container, choices, importCtx);
}

function _findNameConflicts(container, importCtx = {}) {
  const existingByName = new Map();
  for (const [id, sh] of Object.entries(getState().scene.shaders)) {
    existingByName.set(sh.name, id);
  }
  const seen = new Set();
  const out  = [];
  const sigIndex = _buildSignatureIndex();   // read-only here (no shaders added yet)
  for (const mat of container.materials) {
    if (seen.has(mat)) continue;
    seen.add(mat);
    const name = mat.name || 'Material';
    const existingId = existingByName.get(name);
    if (!existingId) continue;
    // Content match → auto-dedupe silently in _doRegister; no modal needed.
    if (_findContentDuplicate(mat, importCtx, sigIndex)) continue;
    out.push({ name, existingShaderId: existingId, importedMaterial: mat });
  }
  return out;
}

/**
 * Return the id of an existing shader whose appearance is identical to the
 * one we'd build from `mat`. Used to auto-merge re-dragged assets without
 * prompting the user. Compares type, color, opacity, roughness, metallic,
 * uvBase, and texture asset id.
 */
function _findContentDuplicate(mat, importCtx = {}, sigIndex = null) {
  const fresh = _buildEntryFromMaterial(mat, importCtx);
  const sig = _shaderSignature(fresh, mat);
  if (!sig) return null;
  // O(1) lookup against a prebuilt signature→id index (the import paths pass
  // one — finding #15: rebuilding every existing shader's signature per material
  // was O(M×S)). Falls back to a linear scan for any ad-hoc caller.
  if (sigIndex) return sigIndex.get(sig) ?? null;
  for (const [id, sh] of Object.entries(getState().scene.shaders)) {
    if (_shaderSignature(sh) === sig) return id;
  }
  return null;
}

// Build a signature→shaderId index over the current shader library. First id
// per signature wins, matching the linear scan's first-match (Object.entries
// order). Lets the import dedupe do O(1) lookups instead of an O(S) rescan per
// material (#15). Callers that add/replace shaders mid-import keep it current.
function _buildSignatureIndex() {
  const idx = new Map();
  for (const [id, sh] of Object.entries(getState().scene.shaders)) {
    const sig = _shaderSignature(sh);
    if (sig && !idx.has(sig)) idx.set(sig, id);
  }
  return idx;
}

function _shaderSignature(sh, material = null) {
  const signature = shaderSignature(sh, {
    assets: getState().scene.assetLibrary,
    material,
  });
  return signature.eligible ? signature.key : null;
}

function _promptMergeChoices(conflicts) {
  return new Promise(resolve => {
    dispatch(EVENTS.MODAL_OPEN, {
      id: 'shaderMerge',
      conflicts,
      onClose: (result) => {
        const choices = {};
        if (result?.choices && typeof result.choices === 'object') {
          for (const c of conflicts) {
            choices[c.name] = result.choices[c.name] ?? 'rename';
          }
        } else {
          // Cancelled — fall back to Rename so the import still completes.
          for (const c of conflicts) choices[c.name] = 'rename';
        }
        resolve(choices);
      },
    });
  });
}

function _doRegister(container, choices, importCtx = {}) {
  const byMaterial = new Map();
  const shaderIds  = [];

  const existingByName = new Map();
  for (const [id, sh] of Object.entries(getState().scene.shaders)) {
    existingByName.set(sh.name, id);
  }
  // Signature→id index, maintained as we add/replace below so within-import
  // dedupe stays O(1) instead of an O(S) rescan per material (#15).
  const sigIndex = _buildSignatureIndex();

  for (const mat of container.materials) {
    if (byMaterial.has(mat)) continue;
    const name = mat.name || 'Material';

    // Build the entry + signature ONCE per material (reused on every branch);
    // the content-dedupe lookup is now O(1) against sigIndex.
    const fresh = _buildEntryFromMaterial(mat, importCtx);
    const sig = _shaderSignature(fresh, mat);

    // ── Auto-dedupe by content (any matching existing/earlier shader) ──
    const dupId = sig ? sigIndex.get(sig) ?? null : null;
    if (dupId) {
      const existingMat = _materials.get(dupId);
      if (existingMat) {
        for (const m of container.meshes) if (m.material === mat) m.material = existingMat;
        try { mat.dispose(); } catch { /* fall through */ }
      }
      byMaterial.set(mat, dupId);
      continue;
    }

    const conflictId = existingByName.get(name);
    const choice = conflictId ? (choices[name] ?? 'rename') : null;

    if (conflictId && choice === 'useExisting') {
      // Re-point any container mesh from the imported material to the existing one.
      const existingMat = _materials.get(conflictId);
      if (existingMat) {
        for (const m of container.meshes) if (m.material === mat) m.material = existingMat;
        try { mat.dispose(); } catch { /* fall through */ }
      }
      byMaterial.set(mat, conflictId);
      continue;
    }

    if (conflictId && choice === 'replace') {
      // Swap the imported material into the existing shader id, so currently
      // linked meshes keep their shader id but visually pick up the new look.
      const existingMat = _materials.get(conflictId);
      const existingEntry = getState().scene.shaders[conflictId];
      const oldSig = existingEntry ? _shaderSignature(existingEntry) : null;
      if (existingEntry) {
        for (const meshId of existingEntry.linkedMeshIds) {
          const m = AssetLoader.getBabylonMesh(meshId);
          if (m && m.material === existingMat) m.material = mat;
        }
      }
      try { existingMat?.dispose(); } catch { /* */ }
      _materials.set(conflictId, mat);

      setState(state => {
        const sh = state.scene.shaders[conflictId];
        if (!sh) return state;
        return {
          ...state,
          scene: {
            ...state.scene,
            shaders: {
              ...state.scene.shaders,
              [conflictId]: {
                ...sh,
                // Adopt the imported material's *appearance* but keep id, name,
                // and linkedMeshIds (and uvBase, since that's a scene-level choice).
                type: fresh.type,
                diffuseColor: fresh.diffuseColor,
                opacity: fresh.opacity,
                roughness: fresh.roughness,
                metallic: fresh.metallic,
              },
            },
          },
        };
      }, SILENT);
      byMaterial.set(mat, conflictId);
      dispatch(EVENTS.SHADER_UPDATED, { shaderId: conflictId, field: 'material' });
      // conflictId's appearance (signature) changed — keep the index current.
      if (oldSig && sigIndex.get(oldSig) === conflictId) sigIndex.delete(oldSig);
      const updated = getState().scene.shaders[conflictId];
      if (updated) {
        const newSig = _shaderSignature(updated);
        if (newSig && !sigIndex.has(newSig)) sigIndex.set(newSig, conflictId);
      }
      continue;
    }

    // Default path — register `fresh` as a new shader. On 'rename' the name is
    // bumped for namespace uniqueness (name isn't part of the signature).
    const entry = fresh;
    if (conflictId) {
      entry.name = _nextAvailableName(name);
      mat.name = entry.name;
    }
    _materials.set(entry.id, mat);
    byMaterial.set(mat, entry.id);
    shaderIds.push(entry.id);

    setState(state => ({
      ...state,
      scene: {
        ...state.scene,
        shaders: { ...state.scene.shaders, [entry.id]: entry },
      },
    }), SILENT);
    dispatch(EVENTS.SHADER_CREATED, { shaderId: entry.id });
    // A later identical material in this same import now dedups to this one.
    if (sig && !sigIndex.has(sig)) sigIndex.set(sig, entry.id);
  }

  return { shaderIds, byMaterial };
}

/**
 * Create a new ShaderEntry + Babylon material from scratch. Useful for
 * shaders the user spawns inside the ShaderPanel.
 *
 * @param {Partial<ShaderEntry>} [partial]
 * @returns {string} shaderId
 */
export function createShader(partial = {}) {
  // Honour a requested id when free — undo/redo of delete/duplicate recreate
  // shaders from snapshots and must keep their original ids so older stack
  // entries (assigns) stay valid (review M14).
  const id   = (partial.id && !getState().scene.shaders[partial.id]) ? partial.id : _nextShaderId();
  const name = _nextAvailableName(partial.name ?? 'Material');
  const type = partial.type ?? 'standard';

  const scene = SceneManager.getScene();
  const mat = _createBabylonMaterial(type, name, scene);
  _materials.set(id, mat);

  const entry = {
    id, name, type,
    diffuseColor:          partial.diffuseColor ?? FALLBACK_DIFFUSE,
    diffuseTextureAssetId: partial.diffuseTextureAssetId ?? null,
    uvBase: {
      offsetX:  partial.uvBase?.offsetX  ?? 0,
      offsetY:  partial.uvBase?.offsetY  ?? 0,
      scaleX:   partial.uvBase?.scaleX   ?? 1,
      scaleY:   partial.uvBase?.scaleY   ?? 1,
      rotation: partial.uvBase?.rotation ?? 0,
    },
    opacity:   partial.opacity   ?? 1,
    roughness: partial.roughness ?? 0.5,
    metallic:  partial.metallic  ?? 0,
    linkedMeshIds: [],
  };
  _applyEntryToMaterial(mat, entry);

  setState(state => ({
    ...state,
    scene: { ...state.scene, shaders: { ...state.scene.shaders, [id]: entry } },
  }), SILENT);

  dispatch(EVENTS.SHADER_CREATED, { shaderId: id });
  return id;
}

/**
 * Recreate a shader from a persisted entry, keeping its original id so
 * restored SceneObjects' `shaderId` references stay valid (BLUEPRINT §10 load
 * step 5). linkedMeshIds start empty — rebuilt later by rebuildLinkedIndex().
 *
 * Texture handling: a user-loaded texture (restored by AssetLoader under the
 * same assetId) is rebound. glTF-embedded ("imported") textures are not
 * restored this phase — the shader falls back to its persisted diffuse colour.
 *
 * @param {object} entry  persisted ShaderEntry
 * @returns {string} shaderId (same as entry.id)
 */
export function restoreShader(entry) {
  const id   = entry.id;
  const name = entry.name ?? 'Material';
  const type = entry.type ?? 'standard';
  const scene = SceneManager.getScene();
  const mat = _createBabylonMaterial(type, name, scene);
  _materials.set(id, mat);

  const restored = {
    id, name, type,
    diffuseColor:          entry.diffuseColor ?? FALLBACK_DIFFUSE,
    diffuseTextureAssetId: entry.diffuseTextureAssetId ?? null,
    uvBase: {
      offsetX:  entry.uvBase?.offsetX  ?? 0,
      offsetY:  entry.uvBase?.offsetY  ?? 0,
      scaleX:   entry.uvBase?.scaleX   ?? 1,
      scaleY:   entry.uvBase?.scaleY   ?? 1,
      rotation: entry.uvBase?.rotation ?? 0,
    },
    opacity:   entry.opacity   ?? 1,
    roughness: entry.roughness ?? 0.5,
    metallic:  entry.metallic  ?? 0,
    linkedMeshIds: [],
  };
  _applyEntryToMaterial(mat, restored);

  const tex = restored.diffuseTextureAssetId
    ? AssetLoader.getBabylonTexture(restored.diffuseTextureAssetId)
    : null;
  if (tex) _setMaterialField(mat, 'diffuseTextureAssetId', restored.diffuseTextureAssetId, type);
  else restored.diffuseTextureAssetId = null;   // imported texture not restored → colour only

  setState(state => ({
    ...state,
    scene: { ...state.scene, shaders: { ...state.scene.shaders, [id]: restored } },
  }), SILENT);
  dispatch(EVENTS.SHADER_CREATED, { shaderId: id });
  return id;
}

/**
 * Dispose every Babylon material + UV-override clone. BLUEPRINT §14.2
 * "on new/load project".
 */
export function resetAll() {
  for (const m of _materials.values()) { try { m.dispose(); } catch { /* */ } }
  for (const c of _uvClones.values()) { try { c.material?.dispose(); } catch { /* */ } }
  _materials.clear();
  _uvClones.clear();
}

/**
 * Mutate one field of a shader. Live-updates the Babylon material so every
 * linked mesh re-renders without per-mesh clones (per BLUEPRINT §10).
 *
 * @param {string} shaderId
 * @param {string} field   'name'|'type'|'diffuseColor'|'diffuseTextureAssetId'|'uvBase'|'opacity'|'roughness'|'metallic'
 * @param {*} value
 */
export function updateShader(shaderId, field, value) {
  const entry = getState().scene.shaders[shaderId];
  if (!entry) return;
  const mat = _materials.get(shaderId);
  if (!mat) return;

  setState(state => {
    const sh = state.scene.shaders[shaderId];
    if (!sh) return state;
    let updated;
    if (field === 'uvBase' && value && typeof value === 'object') {
      updated = { ...sh, uvBase: { ...sh.uvBase, ...value } };
    } else {
      updated = { ...sh, [field]: value };
    }
    return {
      ...state,
      scene: { ...state.scene, shaders: { ...state.scene.shaders, [shaderId]: updated } },
    };
  }, SILENT);

  const after = getState().scene.shaders[shaderId];
  if (field === 'type') {
    // Type changes can't be mutated in place — rebuild the Babylon material
    // and reassign every linked mesh + UV-override clone (review H8).
    _rebuildMaterialForType(shaderId, after);
  } else {
    _setMaterialField(mat, field, value, after.type);
    // Per-mesh UV-override clones derive from this shader — they must track
    // every field edit or they drift visually forever (review H7).
    _applyFieldToUvClones(shaderId, field, value, after.type);
  }

  dispatch(EVENTS.SHADER_UPDATED, { shaderId, field });
}

function _slotOf(mat) {
  return ('albedoTexture' in mat) ? 'albedoTexture'
       : ('baseTexture'   in mat) ? 'baseTexture'
       : 'diffuseTexture';
}

/**
 * Propagate one shader-field edit onto every UV-override clone derived from
 * the shader. `uvBase` is skipped — the per-mesh override owns the clone's
 * UV transform. Texture swaps re-clone so UV offsets stay mesh-private.
 */
function _applyFieldToUvClones(shaderId, field, value, type) {
  if (field === 'uvBase') return;
  for (const [meshId, entry] of _uvClones.entries()) {
    if (entry.shaderId !== shaderId) continue;
    if (field === 'diffuseTextureAssetId') {
      const shared = value ? AssetLoader.getBabylonTexture(value) : null;
      let tex = shared;
      if (shared && typeof shared.clone === 'function') {
        try { tex = shared.clone(); } catch { tex = shared; }
      }
      entry.material[_slotOf(entry.material)] = tex;
      const uv = getState().scene.uvOverrides[meshId];
      if (uv) _applyUVToMaterial(entry.material, uv);
      continue;
    }
    _setMaterialField(entry.material, field, value, type);
  }
}

/**
 * Recreate the shader's Babylon material at a new type, carry the texture
 * across, reassign linked meshes, and rebuild UV-override clones from the
 * new base. The old material is disposed (textures survive — material
 * dispose does not cascade to textures).
 */
function _rebuildMaterialForType(shaderId, entry) {
  const old = _materials.get(shaderId);
  const scene = SceneManager.getScene();
  const next = _createBabylonMaterial(entry.type, entry.name, scene);
  _applyEntryToMaterial(next, entry);
  if (entry.diffuseTextureAssetId) {
    _setMaterialField(next, 'diffuseTextureAssetId', entry.diffuseTextureAssetId, entry.type);
  } else if (old) {
    const tex = old[_slotOf(old)];
    if (tex) {
      next[_slotOf(next)] = tex;
      _applyUVToMaterial(next, entry.uvBase);
    }
  }
  _materials.set(shaderId, next);

  for (const meshId of entry.linkedMeshIds) {
    if (_uvClones.has(meshId)) continue;   // override meshes rebuilt below
    const mesh = AssetLoader.getBabylonMesh(meshId);
    if (mesh) mesh.material = next;
  }

  for (const [meshId, cloneEntry] of [..._uvClones.entries()]) {
    if (cloneEntry.shaderId !== shaderId) continue;
    try { cloneEntry.material.dispose?.(); } catch { /* */ }
    _uvClones.delete(meshId);
    const uv = getState().scene.uvOverrides[meshId];
    if (uv) {
      setUVOverride(meshId, uv);           // recreates the clone from `next`
    } else {
      const mesh = AssetLoader.getBabylonMesh(meshId);
      if (mesh) mesh.material = next;
    }
  }

  try { old?.dispose?.(); } catch { /* */ }
}

/**
 * Convenience: apply a swatch's hex to a shader's diffuse color.
 * @param {string} shaderId
 * @param {string} hex
 */
export function applySwatchColor(shaderId, hex) {
  updateShader(shaderId, 'diffuseColor', hex);
  dispatch(EVENTS.COLOR_APPLIED, { shaderId, hex });
}

/**
 * Clone a shader. The new shader gets `.NNN` appended to the source name, an
 * empty linkedMeshIds list, and a cloned Babylon material that shares the
 * source's texture references (not copies — same as Blender's "duplicate
 * material with linked data").
 *
 * @param {string} shaderId
 * @returns {string|null} newShaderId
 */
export function duplicateShader(shaderId) {
  const source = getState().scene.shaders[shaderId];
  if (!source) return null;
  const sourceMat = _materials.get(shaderId);
  if (!sourceMat) return null;

  const newId   = _nextShaderId();
  const newName = _nextAvailableName(source.name);
  const clone   = sourceMat.clone(newName);   // shared texture refs by design
  _materials.set(newId, clone);

  const entry = { ...source, id: newId, name: newName, linkedMeshIds: [] };

  setState(state => ({
    ...state,
    scene: { ...state.scene, shaders: { ...state.scene.shaders, [newId]: entry } },
  }), SILENT);

  dispatch(EVENTS.SHADER_DUPLICATED, { shaderId: newId, sourceId: shaderId });
  return newId;
}

/**
 * Delete a shader. Refuses (returns false) when meshes are still linked —
 * callers should reassign first.
 * @param {string} shaderId
 * @returns {boolean}
 */
export function deleteShader(shaderId) {
  const entry = getState().scene.shaders[shaderId];
  if (!entry) return false;
  if (entry.linkedMeshIds.length > 0) return false;

  const mat = _materials.get(shaderId);
  if (mat) mat.dispose();
  _materials.delete(shaderId);

  setState(state => {
    const next = { ...state.scene.shaders };
    delete next[shaderId];
    return { ...state, scene: { ...state.scene, shaders: next } };
  }, SILENT);

  return true;
}

/**
 * Replace a mesh's shader. Disposes any UV-override clone the mesh was using
 * (the override no longer makes sense for the new shader); state.uvOverrides
 * is cleared for that mesh.
 *
 * @param {string} shaderId
 * @param {string} meshId
 */
export function assignToMesh(shaderId, meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj) return;
  const newMat = _materials.get(shaderId);
  if (!newMat) return;

  // Unlink from any prior shader.
  if (obj.shaderId && obj.shaderId !== shaderId) {
    unlinkMesh(obj.shaderId, meshId);
  }

  // A UV-override clone is tied to its source shader; drop it on reassign.
  const cloneEntry = _uvClones.get(meshId);
  if (cloneEntry) {
    cloneEntry.material.dispose();
    _uvClones.delete(meshId);
    setState(state => {
      if (!state.scene.uvOverrides[meshId]) return state;
      const next = { ...state.scene.uvOverrides };
      delete next[meshId];
      return { ...state, scene: { ...state.scene, uvOverrides: next } };
    }, SILENT);
  }

  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (mesh) mesh.material = newMat;

  setState(state => {
    const o = state.scene.objects[meshId];
    if (!o) return state;
    return {
      ...state,
      scene: { ...state.scene, objects: { ...state.scene.objects, [meshId]: { ...o, shaderId } } },
    };
  }, SILENT);

  linkMesh(shaderId, meshId);
  dispatch(EVENTS.SHADER_ASSIGNED, { shaderId, meshId });
}

/** Clear any shader assignment from a mesh and remove UV override state tied to it. */
export function clearMeshShader(meshId) {
  const obj = getState().scene.objects[meshId];
  if (!obj) return;
  if (obj.shaderId) unlinkMesh(obj.shaderId, meshId);

  const cloneEntry = _uvClones.get(meshId);
  if (cloneEntry) {
    cloneEntry.material.dispose();
    _uvClones.delete(meshId);
  }

  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (mesh) mesh.material = null;

  setState(state => {
    const o = state.scene.objects[meshId];
    if (!o) return state;
    const nextObjects = { ...state.scene.objects, [meshId]: { ...o, shaderId: null } };
    const nextUv = { ...state.scene.uvOverrides };
    delete nextUv[meshId];
    return { ...state, scene: { ...state.scene, objects: nextObjects, uvOverrides: nextUv } };
  }, SILENT);

  dispatch(EVENTS.SHADER_ASSIGNED, { shaderId: null, meshId });
}

/**
 * Apply a per-mesh UV override. Clones the mesh's shared material once (with
 * its texture so the offset doesn't leak), assigns the clone to the mesh.
 * Subsequent calls reuse the existing clone.
 *
 * @param {string} meshId
 * @param {{ offsetX?, offsetY?, scaleX?, scaleY?, rotation? }} uv
 */
export function setUVOverride(meshId, uv) {
  const obj = getState().scene.objects[meshId];
  if (!obj?.shaderId) return;
  const base = _materials.get(obj.shaderId);
  if (!base) return;

  let entry = _uvClones.get(meshId);
  if (!entry || entry.shaderId !== obj.shaderId) {
    if (entry?.material) entry.material.dispose();
    const clone = _cloneMaterialWithTexture(base, `${obj.shaderId}__${meshId}__uv`);
    entry = { shaderId: obj.shaderId, material: clone };
    _uvClones.set(meshId, entry);
    const mesh = AssetLoader.getBabylonMesh(meshId);
    if (mesh) mesh.material = clone;
  }

  // Merge with the existing override so partial updates work.
  const prev = getState().scene.uvOverrides[meshId] ?? {};
  const merged = {
    meshId,
    shaderId: obj.shaderId,
    offsetX:  uv.offsetX  ?? prev.offsetX  ?? 0,
    offsetY:  uv.offsetY  ?? prev.offsetY  ?? 0,
    scaleX:   uv.scaleX   ?? prev.scaleX   ?? 1,
    scaleY:   uv.scaleY   ?? prev.scaleY   ?? 1,
    rotation: uv.rotation ?? prev.rotation ?? 0,
  };

  _applyUVToMaterial(entry.material, merged);

  setState(state => ({
    ...state,
    scene: { ...state.scene, uvOverrides: { ...state.scene.uvOverrides, [meshId]: merged } },
  }), SILENT);

  dispatch(EVENTS.UV_OVERRIDE_CHANGED, { meshId });
}

/**
 * Drop a per-mesh UV override; the mesh goes back to the shared shader material.
 * @param {string} meshId
 */
export function clearUVOverride(meshId) {
  const entry = _uvClones.get(meshId);
  if (entry) {
    entry.material.dispose();
    _uvClones.delete(meshId);
  }
  const obj  = getState().scene.objects[meshId];
  const mesh = AssetLoader.getBabylonMesh(meshId);
  if (mesh && obj?.shaderId) {
    const shared = _materials.get(obj.shaderId);
    if (shared) mesh.material = shared;
  }

  setState(state => {
    if (!state.scene.uvOverrides[meshId]) return state;
    const next = { ...state.scene.uvOverrides };
    delete next[meshId];
    return { ...state, scene: { ...state.scene, uvOverrides: next } };
  }, SILENT);

  dispatch(EVENTS.UV_OVERRIDE_CHANGED, { meshId });
}

/**
 * Attach a pre-loaded BABYLON.Texture to a shader's diffuse slot. Used by the
 * Asset-Panel texture drag flow once a texture asset has been instantiated.
 *
 * @param {string} shaderId
 * @param {BABYLON.BaseTexture|null} texture
 */
export function setDiffuseTexture(shaderId, texture) {
  const mat = _materials.get(shaderId);
  if (!mat) return;
  const slot = ('albedoTexture' in mat) ? 'albedoTexture'
             : ('baseTexture'   in mat) ? 'baseTexture'
             : 'diffuseTexture';
  // Dispose the previous texture only if we own it (don't dispose imported
  // textures that came in via registerFromContainer — they belong to the
  // AssetContainer's lifetime).
  const prev = mat[slot];
  if (prev && prev._mxOwned) prev.dispose();
  mat[slot] = texture;
  if (texture) {
    texture._mxOwned = true;
    const entry = getState().scene.shaders[shaderId];
    if (entry) _applyUVToMaterial(mat, entry.uvBase);
  }
}

/**
 * Add a meshId to a shader's linkedMeshIds list (runtime index).
 * @param {string} shaderId
 * @param {string} meshId
 */
export function linkMesh(shaderId, meshId) {
  const shaders = getState().scene.shaders;
  const entry = shaders[shaderId];
  if (!entry) return;
  if (entry.linkedMeshIds.includes(meshId)) return;
  setState(state => {
    const sh = state.scene.shaders[shaderId];
    if (!sh) return state;
    return {
      ...state,
      scene: {
        ...state.scene,
        shaders: {
          ...state.scene.shaders,
          [shaderId]: { ...sh, linkedMeshIds: [...sh.linkedMeshIds, meshId] },
        },
      },
    };
  }, SILENT);
}

/**
 * Remove a meshId from a shader's linkedMeshIds list.
 * @param {string} shaderId
 * @param {string} meshId
 */
export function unlinkMesh(shaderId, meshId) {
  setState(state => {
    const sh = state.scene.shaders[shaderId];
    if (!sh) return state;
    return {
      ...state,
      scene: {
        ...state.scene,
        shaders: {
          ...state.scene.shaders,
          [shaderId]: { ...sh, linkedMeshIds: sh.linkedMeshIds.filter(id => id !== meshId) },
        },
      },
    };
  }, SILENT);
}

/**
 * Reconcile every shader's linkedMeshIds from state.scene.objects. Used after
 * project load, when shaders persisted with `linkedMeshIds: []` need to be
 * re-indexed against the freshly loaded scene objects.
 */
export function rebuildLinkedIndex() {
  const { objects, shaders } = getState().scene;
  const next = {};
  for (const [id, sh] of Object.entries(shaders)) {
    next[id] = { ...sh, linkedMeshIds: [] };
  }
  for (const [meshId, obj] of Object.entries(objects)) {
    if (obj.shaderId && next[obj.shaderId]) {
      next[obj.shaderId].linkedMeshIds.push(meshId);
    }
  }
  setState(state => ({ ...state, scene: { ...state.scene, shaders: next } }), SILENT);
}

// ── Accessors ────────────────────────────────────────────

/**
 * Look up the live Babylon material assigned to a mesh, accounting for any
 * per-mesh UV-override clone.
 * @param {string} meshId
 * @returns {BABYLON.Material|null}
 */
export function getBabylonMaterial(meshId) {
  const clone = _uvClones.get(meshId);
  if (clone) return clone.material;
  const obj = getState().scene.objects[meshId];
  if (!obj?.shaderId) return null;
  return _materials.get(obj.shaderId) ?? null;
}

/** @param {string} shaderId */
export function getMaterialById(shaderId) {
  return _materials.get(shaderId) ?? null;
}

export const ShaderLibrary = {
  registerFromContainer,
  createShader, updateShader, duplicateShader, deleteShader,
  assignToMesh, clearMeshShader, setUVOverride, clearUVOverride, applySwatchColor,
  setDiffuseTexture, rebuildLinkedIndex,
  restoreShader, resetAll,
  linkMesh, unlinkMesh,
  getBabylonMaterial, getMaterialById,
};
