// Import security caps (overhaul plan Decision 19 / task 6.4): max file size,
// and for zip-based formats (3MF) max entry count + max total uncompressed
// size (zip-bomb guard) + path-traversal rejection. Violations throw an Error
// with a user-readable message; the existing import-error modal shows it.
// (The 4x triangle budget of Decision 19 is a separate concern.)

export const IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 1024 ** 3,               // 1 GB
  maxZipEntries: 256,
  maxZipUncompressedBytes: 2 * 1024 ** 3, // 2 GB
});

const mb = (n) => (n / 1024 / 1024).toFixed(0);

/** Throw when a file exceeds the size cap. */
export function assertImportFileSize(size, filename, limits = IMPORT_LIMITS) {
  if (Number.isFinite(size) && size > limits.maxFileBytes) {
    throw new Error(`"${filename}" is too large to import (${mb(size)} MB; the limit is ${mb(limits.maxFileBytes)} MB).`);
  }
}

/** True for an entry name that could escape the package root. */
export function isUnsafeZipPath(name) {
  const n = String(name).split('\\').join('/');
  return n.startsWith('/') || /^[A-Za-z]:/.test(n) || n.split('/').includes('..') || n.includes('\0');
}

/**
 * Inspect an already-opened JSZip's central directory (nothing decompressed):
 * entry count, declared total uncompressed size, unsafe paths.
 * @param {{ files: Record<string, any> }} zip
 */
export function assertZipSafe(zip, label = 'archive', limits = IMPORT_LIMITS) {
  const names = Object.keys(zip.files);
  if (names.length > limits.maxZipEntries) {
    throw new Error(`${label} has too many entries (${names.length}; the limit is ${limits.maxZipEntries}).`);
  }
  let total = 0;
  for (const name of names) {
    if (isUnsafeZipPath(name)) {
      throw new Error(`${label} contains an unsafe file path ("${name}") and was rejected.`);
    }
    total += zip.files[name]?._data?.uncompressedSize ?? 0;
    if (total > limits.maxZipUncompressedBytes) {
      throw new Error(`${label} expands to more than ${mb(limits.maxZipUncompressedBytes)} MB uncompressed and was rejected.`);
    }
  }
}
