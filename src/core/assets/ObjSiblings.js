// OBJ sibling resolution (field report: "obj fails to read mtl") — OBJ loads
// from a blob URL, so the loader's relative `mtllib` / texture requests can't
// resolve. We map sibling filenames → object URLs (from a multi-file drop or
// the file's mounted directory) and swap BABYLON.Tools.PreprocessUrl for the
// duration of the load. The map is kept per assetId so re-instantiation
// rebinds materials too.

import { assertImportFileSize } from '../import/ImportLimits.js';
import { extOf, isTextureExt } from './AssetTypes.js';
import { getDirectoryHandle } from './DirMounts.js';

const BABYLON = window.BABYLON;

const _objSiblings = new Map();   // assetId → Map<lowercase filename, objectURL>

/**
 * Build the sibling filename → object-URL map for an OBJ import/restore.
 * Sources: an explicit drop-set (`opts.siblingFiles`) or the OBJ's parent
 * directory inside a mounted/idb-resolved handle.
 */
export async function collectObjSiblings(opts) {
  // Relink/Refresh (4.5): reuse a prebuilt sibling map (the replaced asset's own)
  // when the picked file brings none — a renamed/updated OBJ usually keeps its
  // mtllib + textures. URLs are shared with the previous map (never revoked here).
  if (opts.siblings instanceof Map && !Array.isArray(opts.siblingFiles)) return new Map(opts.siblings);
  const map = new Map();
  const add = async (name, fileOrHandle) => {
    const ext = extOf(name);
    if (ext !== '.mtl' && !isTextureExt(ext)) return;
    try {
      const file = typeof fileOrHandle.getFile === 'function' ? await fileOrHandle.getFile() : fileOrHandle;
      assertImportFileSize(file.size, name);
      map.set(name.toLowerCase(), URL.createObjectURL(file));
    } catch (err) {
      for (const url of map.values()) URL.revokeObjectURL(url);
      throw new Error(`OBJ material/texture file ${name} could not be read: ${err.message}`, { cause: err });
    }
  };

  if (Array.isArray(opts.siblingFiles)) {
    for (const f of opts.siblingFiles) await add(f.name, f);
  } else if ((opts.dirHandle || opts.directoryHandleKey) && opts.originalPath) {
    // Project restore passes the idb-resolved handle directly (the session
    // mount map only fills after an explicit remount).
    const root = opts.dirHandle ?? getDirectoryHandle(opts.directoryHandleKey);
    if (root) {
      try {
        // Walk to the OBJ's parent directory, then enumerate its files.
        const parts = String(opts.originalPath).split(/[\\/]+/).filter(Boolean);
        let dir = root;
        for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === 'file') await add(name, handle);
        }
      } catch (err) {
        for (const url of map.values()) URL.revokeObjectURL(url);
        throw new Error(`OBJ material folder could not be read: ${err.message}`, { cause: err });
      }
    }
  }
  return map;
}

/** Keep a sibling map per assetId so re-instantiation rebinds materials. */
export function rememberObjSiblings(assetId, map) {
  _objSiblings.set(assetId, map);
}

/**
 * Swap an asset's sibling map WITHOUT revoking anything (RelinkAssetCommand
 * undo/redo owns the URLs of both sets). `null` clears the entry.
 */
export function setObjSiblings(assetId, map) {
  if (map) _objSiblings.set(assetId, map); else _objSiblings.delete(assetId);
}

/** @returns {Map<string,string>|undefined} */
export function getObjSiblings(assetId) {
  return _objSiblings.get(assetId);
}

/** Swap Tools.PreprocessUrl to serve sibling files by filename. Returns restore fn. */
export function installSiblingUrls(map) {
  if (!map?.size || !BABYLON.Tools) return () => {};
  // Same-name fallback: when the OBJ's mtllib statement names a file we don't
  // have but exactly ONE .mtl sibling exists, serve that one (artists rename
  // OBJs without updating mtllib constantly).
  const mtlUrls = [...map.entries()].filter(([n]) => n.endsWith('.mtl')).map(([, u]) => u);
  const soloMtl = mtlUrls.length === 1 ? mtlUrls[0] : null;
  const prev = BABYLON.Tools.PreprocessUrl;
  BABYLON.Tools.PreprocessUrl = (url) => {
    const name = String(url).split(/[\\/]/).pop()?.toLowerCase();
    const hit = name ? map.get(name) : null;
    if (hit) return hit;
    if (soloMtl && name?.endsWith('.mtl')) return soloMtl;
    return typeof prev === 'function' ? prev(url) : url;
  };
  return () => { BABYLON.Tools.PreprocessUrl = prev; };
}

/** Refuse an authored material reference that no provided sibling can resolve. */
export async function noteMissingMtl(blob, filename, map) {
  const head = await blob.slice(0, 65536).text();
  const refs = [...head.matchAll(/^\s*mtllib\s+(.+?)\s*$/gm)]
    .map(m => m[1].trim().split(/[\\/]/).pop()?.toLowerCase()).filter(Boolean);
  const hasSoloMtl = [...(map?.keys() ?? [])].filter(n => n.endsWith('.mtl')).length === 1;
  const missing = refs.filter(r => !map?.has(r));
  if (missing.length && !hasSoloMtl) {
    throw new Error(`${filename}: required MTL file ${missing[0]} was not provided. Include its MTL and texture images with the OBJ.`);
  }
}

/** Revoke one asset's sibling object URLs. */
export function revokeObjSiblings(assetId) {
  const map = _objSiblings.get(assetId);
  if (!map) return;
  for (const url of map.values()) URL.revokeObjectURL(url);
  _objSiblings.delete(assetId);
}

/** Revoke every sibling URL (project reset). */
export function revokeAllObjSiblings() {
  for (const id of [..._objSiblings.keys()]) revokeObjSiblings(id);
}
