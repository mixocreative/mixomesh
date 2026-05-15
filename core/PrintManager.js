import { getState } from './StateManager.js';
import { Toast } from '../ui/Toast.js';
import { MeshValidator } from './MeshValidator.js';

const BABYLON = window.BABYLON;
if (!BABYLON) throw new Error('Babylon.js failed to load');

// ── Scale ────────────────────────────────────────────────

export const SCALE_PRESETS = [
  { category: 'Default',  label: '1:1 Full Scale', ratio: 1 },
  { category: 'Military', label: '1:35 Armor', ratio: 35 },
  { category: 'Military', label: '1:48 Aircraft', ratio: 48 },
  { category: 'Military', label: '1:72 Small', ratio: 72 },
  { category: 'Military', label: '1:100 Micro', ratio: 100 },
  { category: 'Miniatures', label: '28mm Heroic', ratio: 56 },
  { category: 'Miniatures', label: '32mm Standard', ratio: 48 },
  { category: 'Miniatures', label: '54mm Large', ratio: 32 },
  { category: 'Tabletop', label: '6mm Epic', ratio: 300 },
  { category: 'Custom', label: 'Custom', ratio: null },
];

function _exportFactor() {
  const state = getState();
  const wr = state.print.workingRatio > 0 ? state.print.workingRatio : 1;
  const tr = state.print.targetRatio > 0 ? state.print.targetRatio : 1;
  return (wr / tr) * 1000; // BU (m at workingRatio) → mm at targetRatio
}

export function getExportedDimensions(meshId) {
  const state = getState();
  const obj = state.scene.objects[meshId];
  if (!obj?._babylonMesh) return null;

  const mesh = obj._babylonMesh;
  const bb = mesh.getBoundingInfo().boundingBox;
  const size = bb.maximumWorld.subtract(bb.minimumWorld);
  const factor = _exportFactor();

  return {
    x: size.x * factor,
    y: size.y * factor,
    z: size.z * factor,
  };
}

// ── Mesh Collection ──────────────────────────────────────

/**
 * Collect all printable meshes (isPrintPart:true, not empty).
 * If selectedOnly, filter to selected meshes only.
 */
function _collectPrintMeshes(selectedOnly) {
  const state = getState();
  const objects = state.scene.objects;
  const result = [];

  for (const [meshId, obj] of Object.entries(objects)) {
    if (obj.isGhost || !obj.isPrintPart || !obj._babylonMesh) continue;

    // Skip empty TransformNodes (no mesh or zero vertices)
    if (!obj._babylonMesh.getTotalVertices?.() || obj._babylonMesh.getTotalVertices() === 0) {
      continue;
    }

    // If selectedOnly, check if in selection
    if (selectedOnly && !state.selection.selectedIds.includes(meshId)) {
      continue;
    }

    result.push({ meshId, mesh: obj._babylonMesh, obj });
  }

  return result;
}

// ── Texture Export ───────────────────────────────────────

/**
 * Extract all unique textures from a list of meshes and convert to PNG blobs.
 * Returns Map<filename, blob>.
 */
async function _collectTextureBlobs(meshes) {
  const textureMap = new Map(); // assetId → { name, blob }
  const state = getState();

  for (const mesh of meshes) {
    const mat = mesh.material;
    if (!mat) continue;

    // Check diffuse/albedo/base textures
    const textures = [];
    if (mat.diffuseTexture) textures.push(mat.diffuseTexture);
    else if (mat.albedoTexture) textures.push(mat.albedoTexture);
    else if (mat.baseTexture) textures.push(mat.baseTexture);

    for (const tex of textures) {
      if (!tex) continue;

      // Generate unique asset ID-based filename
      const assetId = _getAssetIdForTexture(tex);
      if (!assetId || textureMap.has(assetId)) continue;

      // Re-encode texture to PNG blob
      try {
        const blob = await _textureToBlob(tex);
        textureMap.set(assetId, {
          name: tex.name || assetId,
          blob,
        });
      } catch (err) {
        console.error(`Failed to export texture ${tex.name}:`, err);
      }
    }
  }

  // Build result map with deduped filenames
  const result = new Map();
  const usedNames = new Set();

  for (const [assetId, { name, blob }] of textureMap) {
    let filename = `${name}.png`;
    let counter = 0;
    while (usedNames.has(filename)) {
      counter++;
      filename = `${name}_${counter}.png`;
    }
    usedNames.add(filename);
    result.set(filename, blob);
  }

  return result;
}

/**
 * Find the asset ID for a texture by checking the asset library.
 */
function _getAssetIdForTexture(texture) {
  const state = getState();
  // Textures from imports are stored in assetLibrary
  for (const [assetId, asset] of Object.entries(state.scene.assetLibrary)) {
    if (asset.textures?.[texture.name]) {
      return assetId;
    }
  }
  // Fallback: use texture name
  return texture.name || texture.uniqueId?.toString();
}

/**
 * Convert a Babylon texture to a PNG blob using readPixels and canvas.
 */
async function _textureToBlob(texture) {
  return new Promise((resolve, reject) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = texture.getBaseSize().width;
      canvas.height = texture.getBaseSize().height;

      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to get canvas context');

      // Use Babylon's readPixels to extract texture data
      const pixels = texture.readPixels();
      if (!pixels) throw new Error('readPixels returned null');

      const imageData = ctx.createImageData(canvas.width, canvas.height);
      imageData.data.set(pixels);
      ctx.putImageData(imageData, 0, 0);

      canvas.toBlob(blob => {
        if (!blob) throw new Error('toBlob produced no blob');
        resolve(blob);
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
}

// ── Export ───────────────────────────────────────────────

async function _triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Export OBJ + MTL + textures as ZIP.
 * options: { selectedOnly?: boolean, individually?: boolean }
 */
export async function exportOBJ(options = {}) {
  const { selectedOnly = false, individually = false } = options;

  try {
    // Validate before export
    const validationMap = await MeshValidator.validateAllPrintParts();
    const hasErrors = Array.from(validationMap.values()).some(results =>
      results.some(r => r.severity === 'error')
    );

    if (hasErrors) {
      // Error modal will be shown by caller; just throw
      throw new Error('Validation errors detected. Fix before export.');
    }

    const printMeshes = _collectPrintMeshes(selectedOnly);
    if (printMeshes.length === 0) {
      throw new Error('No printable meshes to export.');
    }

    const state = getState();
    const factor = _exportFactor();

    // Collect textures once for all meshes
    const textureBlobs = await _collectTextureBlobs(
      printMeshes.map(m => m.mesh)
    );

    // Dynamic import JSZip
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();

    if (individually) {
      // Export each mesh to its own OBJ file
      for (const { meshId, mesh } of printMeshes) {
        const prevScale = mesh.scaling.clone();
        mesh.scaling.scaleInPlace(factor);

        const objString = BABYLON.OBJExport.OBJ([mesh], true, `${state.project.name}.mtl`, true);
        const mtlString = BABYLON.OBJExport.MTL([mesh]);

        mesh.scaling = prevScale;

        const meshName = mesh.name || `mesh_${meshId}`;
        zip.file(`${meshName}.obj`, objString);
        zip.file(`${meshName}.mtl`, mtlString);
      }
    } else {
      // Export all meshes to single OBJ
      const meshes = printMeshes.map(m => m.mesh);
      const prevScales = meshes.map(m => m.scaling.clone());

      meshes.forEach(m => m.scaling.scaleInPlace(factor));

      const objString = BABYLON.OBJExport.OBJ(
        meshes,
        true,
        `${state.project.name}.mtl`,
        true
      );
      const mtlString = BABYLON.OBJExport.MTL(meshes);

      meshes.forEach((m, i) => (m.scaling = prevScales[i]));

      zip.file(`${state.project.name}.obj`, objString);
      zip.file(`${state.project.name}.mtl`, mtlString);
    }

    // Add textures folder
    const texFolder = zip.folder('textures');
    for (const [filename, blob] of textureBlobs) {
      texFolder.file(filename, blob);
    }

    const archive = await zip.generateAsync({ type: 'blob' });
    await _triggerDownload(archive, `${state.project.name}.zip`);

    Toast.show(`✓ Exported to ${state.project.name}.zip`, 'success', 3000);
  } catch (err) {
    console.error('Export failed:', err);
    throw err;
  }
}

/**
 * Export STL (geometry-only, no colors).
 * options: { selectedOnly?: boolean }
 */
export async function exportSTL(options = {}) {
  const { selectedOnly = false } = options;

  try {
    // Validate before export
    const validationMap = await MeshValidator.validateAllPrintParts();
    const hasErrors = Array.from(validationMap.values()).some(results =>
      results.some(r => r.severity === 'error')
    );

    if (hasErrors) {
      throw new Error('Validation errors detected. Fix before export.');
    }

    const printMeshes = _collectPrintMeshes(selectedOnly);
    if (printMeshes.length === 0) {
      throw new Error('No printable meshes to export.');
    }

    const state = getState();
    const factor = _exportFactor();
    const meshes = printMeshes.map(m => m.mesh);

    // Apply scale
    const prevScales = meshes.map(m => m.scaling.clone());
    meshes.forEach(m => m.scaling.scaleInPlace(factor));

    // Use Babylon STL export
    BABYLON.STLExport.CreateSTL(
      meshes,
      true, // download
      state.project.name,
      true, // binary
      false, // doNotBakeTransform
      false, // supportInstanced
      false // exportIndividualMeshes
    );

    // Restore scales
    meshes.forEach((m, i) => (m.scaling = prevScales[i]));

    Toast.show(`✓ Exported to ${state.project.name}.stl`, 'success', 3000);
  } catch (err) {
    console.error('STL export failed:', err);
    throw err;
  }
}

export const PrintManager = {
  exportOBJ,
  exportSTL,
  getExportedDimensions,
  SCALE_PRESETS,
};
