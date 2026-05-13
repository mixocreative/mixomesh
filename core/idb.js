const DB_NAME    = 'mixomesh';
const DB_VERSION = 1;
const STORE_HANDLES = 'handles';   // FileSystemDirectoryHandle objects (kept session-to-session)
const STORE_KV      = 'kv';        // Generic key/value (autosave, recent projects, …)

let _dbPromise = null;

function _openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_HANDLES)) db.createObjectStore(STORE_HANDLES);
      if (!db.objectStoreNames.contains(STORE_KV))      db.createObjectStore(STORE_KV);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return _dbPromise;
}

function _tx(store, mode) {
  return _openDB().then(db => db.transaction(store, mode).objectStore(store));
}

function _wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

/** Save a FileSystemDirectoryHandle under a key. */
export async function putHandle(key, handle) {
  const store = await _tx(STORE_HANDLES, 'readwrite');
  return _wrap(store.put(handle, key));
}

/** Retrieve a previously saved FileSystemDirectoryHandle, or undefined. */
export async function getHandle(key) {
  const store = await _tx(STORE_HANDLES, 'readonly');
  return _wrap(store.get(key));
}

/** Remove a saved FileSystemDirectoryHandle. */
export async function deleteHandle(key) {
  const store = await _tx(STORE_HANDLES, 'readwrite');
  return _wrap(store.delete(key));
}

/** List all stored handle keys. */
export async function listHandleKeys() {
  const store = await _tx(STORE_HANDLES, 'readonly');
  return _wrap(store.getAllKeys());
}

/** Generic key/value put. */
export async function kvSet(key, value) {
  const store = await _tx(STORE_KV, 'readwrite');
  return _wrap(store.put(value, key));
}

/** Generic key/value get. */
export async function kvGet(key) {
  const store = await _tx(STORE_KV, 'readonly');
  return _wrap(store.get(key));
}

/** Generic key/value delete. */
export async function kvDelete(key) {
  const store = await _tx(STORE_KV, 'readwrite');
  return _wrap(store.delete(key));
}
