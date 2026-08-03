import { SUPPORTED_EXTENSIONS, SUPPORTED_TEXTURE_EXTENSIONS, extOf } from './AssetTypes.js';

const MESH_EXTENSIONS = new Set(SUPPORTED_EXTENSIONS);
const TEXTURE_EXTENSIONS = new Set(SUPPORTED_TEXTURE_EXTENSIONS);

function freezeRow(row) { return Object.freeze({ ...row }); }

function compareAssetRows(a, b) {
  return a.name.localeCompare(b.name)
    || a.path.localeCompare(b.path)
    || a.mountKey.localeCompare(b.mountKey);
}

/** Create an immutable, path-deduplicated projection of mounted asset rows. */
export function createAssetIndex(rows = []) {
  const files = new Map();
  const folders = new Map();
  for (const row of rows) {
    if (!row?.mountKey || typeof row.path !== 'string') continue;
    const key = `${row.mountKey}:${row.path}`;
    if (row.kind === 'file' && !files.has(key)) files.set(key, freezeRow(row));
    if (row.kind === 'folder' && !folders.has(key)) folders.set(key, freezeRow(row));
  }
  return Object.freeze({
    files: Object.freeze([...files.values()].sort(compareAssetRows)),
    folders: Object.freeze([...folders.values()].sort(compareAssetRows)),
  });
}

/** Scan once through the adapter; subsequent rendering/searching is index-only. */
export async function scanAssetMount(storage, mount) {
  const rows = [];
  async function walk(ref, name, path, parentPath, sourcePath) {
    rows.push({ mountKey: mount.mountKey, name, path, parentPath, sourcePath, kind: 'folder', ref });
    const entries = await storage.listDirectory(ref, path);
    for (const entry of entries) {
      const childSource = sourcePath ? `${sourcePath}/${entry.name}` : entry.name;
      if (entry.kind === 'directory') {
        await walk(entry.ref, entry.name, entry.path, path, childSource);
        continue;
      }
      const ext = extOf(entry.name);
      const assetKind = TEXTURE_EXTENSIONS.has(ext) ? 'texture' : MESH_EXTENSIONS.has(ext) ? 'mesh' : null;
      if (!assetKind) continue;
      rows.push({
        mountKey: mount.mountKey,
        name: entry.name,
        path: entry.path,
        parentPath: path,
        sourcePath: childSource,
        kind: 'file',
        assetKind,
        ext,
        ref: entry.ref,
      });
    }
  }
  await walk(mount.ref, mount.name, mount.name, '', '');
  return createAssetIndex(rows);
}

/** Combine per-mount indexes without exposing their live refs outside the index. */
export function combineAssetIndexes(indexes) {
  return createAssetIndex(indexes.flatMap(index => [...index.folders, ...index.files]));
}

/** Query one folder, its descendants, or every mounted library. */
export function queryAssets(index, q) {
  const needle = (q.text ?? '').trim().toLocaleLowerCase();
  const folderPrefix = q.folderPath ? `${q.folderPath}/` : '';
  return index.files
    .filter(file => {
      if (q.scope === 'all') return true;
      if (file.mountKey !== q.mountKey) return false;
      if (q.scope === 'descendants') return file.parentPath === q.folderPath || file.path.startsWith(folderPrefix);
      return file.parentPath === q.folderPath;
    })
    .filter(file => q.kind === 'all' || file.assetKind === q.kind)
    .filter(file => !needle || `${file.name}\n${file.path}`.toLocaleLowerCase().includes(needle))
    .toSorted(compareAssetRows);
}

/** Preserve a refreshed selection, falling back through ancestors to mount root. */
export function nearestFolderPath(index, mountKey, requestedPath) {
  const paths = new Set(index.folders.filter(folder => folder.mountKey === mountKey).map(folder => folder.path));
  if (!paths.size) return null;
  let candidate = requestedPath;
  while (candidate && !paths.has(candidate)) candidate = candidate.includes('/') ? candidate.slice(0, candidate.lastIndexOf('/')) : '';
  if (paths.has(candidate)) return candidate;
  const root = index.folders.find(folder => folder.mountKey === mountKey && folder.parentPath === '');
  return root?.path ?? null;
}
