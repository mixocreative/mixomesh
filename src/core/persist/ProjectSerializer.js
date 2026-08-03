// Save-side document assembly: base64 codecs, world-transform (de)compose,
// and buildDocument with its asset/object/group serialise helpers. All
// AssetLoader calls go through the API OBJECT — monkey-patching it is the
// established headless-test seam (bundle-1 plan 2026-06-11).

import { getState } from '../StateManager.js';
import { SceneManager } from '../SceneManager.js';
import { settleImportBounce } from '../scene/ImportBounce.js';
import { encodeBase64 } from '../workers/base64Codec.js';
import { encodeBase64Async } from '../Base64Worker.js';
import { AssetLoader } from '../AssetLoader.js';
import { sha256Hex } from '../hash.js';
import { reportError } from '../../ui/Status.js';
import { t } from '../../i18n/index.js';
import { SCHEMA_VERSION } from './constants.js';

const BABYLON = window.BABYLON;

// ── Base64 / filename helpers ────────────────────────────

// Sync encode (shared codec, byte-identical to the worker path). Kept for any
// synchronous caller + the byte-fidelity tests; manual save uses the off-thread
// encodeBase64Async (audit #3) but falls back to this exact codec.
export function b64FromBuf(buf) {
  return encodeBase64(buf);
}

export function bufFromB64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i === -1 ? '' : name.slice(i).toLowerCase();
}

// ── Transform (de)serialise ──────────────────────────────

export function decompose(node) {
  node.computeWorldMatrix(true);
  const s = new BABYLON.Vector3();
  const q = new BABYLON.Quaternion();
  const p = new BABYLON.Vector3();
  node.getWorldMatrix().decompose(s, q, p);
  return { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], s: [s.x, s.y, s.z] };
}

/** Place an unparented node at a saved world transform. */
export function applyWorld(node, t) {
  if (!t) return;
  node.setParent(null);
  node.position.set(t.p[0], t.p[1], t.p[2]);
  node.rotationQuaternion = new BABYLON.Quaternion(t.q[0], t.q[1], t.q[2], t.q[3]);
  node.scaling.set(t.s[0], t.s[1], t.s[2]);
}

// ── Serialise ────────────────────────────────────────────

export function stripFileData(a) {
  const { fileData, ...rest } = a;   // never keep base64 in live state
  return rest;
}

async function _serialiseAssetLibrary({ skipEmbed = false } = {}) {
  const lib = getState().scene.assetLibrary;
  const out = [];
  for (const a of Object.values(lib)) {
    const base = {
      id: a.id, name: a.name, filename: a.filename,
      displayName: a.displayName ?? null,
      originalPath: a.originalPath ?? null, extension: a.extension,
      kind: a.kind ?? 'mesh', sourceUnit: a.sourceUnit ?? 'millimeters',
      unitConfirmed: a.unitConfirmed !== false, modelRatio: a.modelRatio ?? 1,
      directoryHandleKey: a.directoryHandleKey ?? null,
      fileHandleKey: a.fileHandleKey ?? null,
      isImported: !!a.isImported,
      // §10b texture identity — drive dedupe scoping + reload rebind.
      sourceFileHash: a.sourceFileHash ?? null,
      sourceAssetId: a.sourceAssetId ?? null,
      babylonTextureName: a.babylonTextureName ?? null,
      libraryItem: a.libraryItem ?? null,
      thumbnailDataUrl: typeof a.thumbnailDataUrl === 'string'
        && a.thumbnailDataUrl.startsWith('data:') ? a.thumbnailDataUrl : null,
      fileData: null, contentHash: null,
    };
    // Embed bytes for meshes + user-loaded textures. glTF-embedded textures
    // are owned by their container — no standalone bytes to keep. Autosave
    // passes skipEmbed (arch A9): re-encoding every asset to base64 each
    // 60s froze the main thread on big scenes; recovery resolves assets via
    // the live tiers (dir / hash-scan / file handle) using the kept hash.
    //
    // EXCEPTION (M7): a LOOSE drag-drop has no dir/file handle, so its embedded
    // bytes are the ONLY recovery path — autosave must embed it anyway or
    // crash-recovery resolves it to a ghost. Container-owned textures still
    // never carry standalone bytes (skipped either way).
    const isContainerTexture = a.kind === 'texture' && a.isImported;
    const hasLiveTier = !!a.directoryHandleKey || !!a.fileHandleKey;
    if (skipEmbed && (hasLiveTier || isContainerTexture)) {
      base.contentHash = a.contentHash ?? null;
    } else if (!isContainerTexture) {
      try {
        const buf = await AssetLoader.getAssetBytes(a.id);
        if (buf) {
          // Off-thread base64 so a large asset doesn't freeze the UI on save
          // (audit #3); falls back to the identical sync codec without a Worker.
          base.fileData    = await encodeBase64Async(buf);
          // Bytes are immutable per assetId — reuse the import-time hash
          // instead of re-hashing on every save (review M16).
          base.contentHash = a.contentHash ?? await sha256Hex(buf);
        }
      } catch (err) {
        // Surface loudly: a silent miss here writes an incomplete .mixo the
        // user believes is a full snapshot.
        reportError(err, { title: t('toast.assetEmbedFailed', { name: a.filename }) });
      }
    }
    out.push(base);
  }
  return out;
}

function _serialiseSceneObjects() {
  const { objects } = getState().scene;
  return Object.values(objects).map(o => {
    const mesh = AssetLoader.getBabylonMesh(o.id);
    let containerMeshIndex = Number.isInteger(o.containerMeshIndex) ? o.containerMeshIndex : 0;
    if (mesh && !o.isGhost) {
      const geom = AssetLoader.getContainerGeomMeshes(o.assetId);
      const idx = geom.findIndex(m => m.metadata?.meshId === o.id);
      if (idx >= 0) containerMeshIndex = idx;
    }
    return {
      id: o.id, name: o.name, assetId: o.assetId,
      collectionId: o.collectionId ?? null, parentId: o.parentId ?? null,
      shaderId: o.shaderId ?? null,
      visible: o.visible !== false, locked: !!o.locked,
      isGhost: !!o.isGhost, isUnlinked: !!o.isUnlinked,
      isPrintPart: o.isPrintPart !== false,
      sourceGroupId: o.sourceGroupId ?? null,
      logicalObjectId: o.logicalObjectId ?? null,
      isInternalPart: !!o.isInternalPart,
      containerMeshIndex,
      // Per-object scale ratio (2026-06-16). Persisted so each object keeps its
      // ratio across save/reload, never lost.
      ratio: (Number.isFinite(o.ratio) && o.ratio > 0) ? o.ratio : 1,
      // Auto-fix geometry edits (weld / normal-flip) are baked into live
      // vertices, not the raw source bytes — persist the applied fix types so
      // they replay on reload (M1) instead of vanishing.
      geometryFixes: Array.isArray(o.geometryFixes) && o.geometryFixes.length ? [...o.geometryFixes] : undefined,
      transform: mesh ? decompose(mesh) : (o._savedTransform ?? null),
    };
  });
}

function _serialiseGroups() {
  const scene = SceneManager.getScene();
  const { groups } = getState().scene;
  return Object.values(groups).map(g => {
    const node = scene.transformNodes.find(t => t.metadata?.groupId === g.id);
    return {
      id: g.id, name: g.name, parentId: g.parentId ?? null,
      childIds: [...(g.childIds ?? [])],
      origin: g.origin === 'import' ? 'import' : 'user',
      transform: node ? decompose(node) : null,
    };
  });
}

/**
 * Assemble the full .mixo document from live state.
 * @param {{ skipEmbed?: boolean }} [opts]  skipEmbed = autosave path (A9).
 */
export async function buildDocument(opts = {}) {
  // Snap any in-flight import/duplicate bounce to its resting scale FIRST: the
  // pop multiplies live node scaling, and _serialiseSceneObjects decomposes the
  // world matrix — a save mid-bounce would otherwise bake the transient factor
  // into the saved transform (duplicate reloaded permanently shrunk — audit
  // dup-reload bug 2026-06-16).
  settleImportBounce();
  const s = getState();
  return {
    version: SCHEMA_VERSION,
    savedAt: new Date().toISOString(),
    project: { name: s.project.name || 'Untitled' },
    sceneSettings: {
      camera: { ...SceneManager.saveCameraState(), followMode: s.scene.camera.followMode ?? 'free' },
      overlays: { ...s.scene.overlays },
      render: { ...s.scene.render },
      renderOut: { ...s.scene.renderOut },
      grid: { ...s.scene.grid },
      cursor3d: { ...s.scene.cursor3d },
    },
    print: { ...s.print },
    assetLibrary: await _serialiseAssetLibrary(opts),
    collections: Object.values(s.scene.collections ?? {}),
    shaders: Object.values(s.scene.shaders).map(({ linkedMeshIds, ...rest }) => rest),
    uvOverrides: { ...s.scene.uvOverrides },
    userSwatches: [...(s.scene.userSwatches ?? [])],
    sceneObjects: _serialiseSceneObjects(),
    groups: _serialiseGroups(),
    selection: { ...s.selection },
    gizmo: { ...s.gizmo },
    // Workspace layout is a per-USER preference (localStorage, PART 13b) —
    // a teammate opening this .mixo must not inherit the saver's layout.
    ui: (({ workspace, panelCollapsed, ...rest }) => rest)(s.ui),
  };
}
