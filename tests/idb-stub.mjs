// In-memory stand-in for src/core/idb.js (no IndexedDB under Node). Mirrors the
// exact export surface PersistenceManager / AssetPanel import. Each test that
// needs isolation calls __reset().

const _handles = new Map();
const _kv      = new Map();

export async function putHandle(key, handle) { _handles.set(key, handle); }
export async function getHandle(key)         { return _handles.get(key); }
export async function deleteHandle(key)      { _handles.delete(key); }
export async function listHandleKeys()       { return [..._handles.keys()]; }

export async function kvSet(key, value) { _kv.set(key, value); }
export async function kvGet(key)        { return _kv.get(key); }
export async function kvDelete(key)     { _kv.delete(key); }
export async function kvKeys()          { return [..._kv.keys()]; }

export { putHandle as putFileHandle, getHandle as getFileHandle, deleteHandle as deleteFileHandle };

export function __reset() { _handles.clear(); _kv.clear(); }
