// Project-load in-flight flag (audit 2026-09-17 F20 / M2). Lives in its own
// leaf module so AssetImport can read it without importing ProjectLoader
// (which imports AssetLoader → AssetImport — a cycle otherwise).

let _loading = false;

/** True from the start of loadProject until it resolves or rejects. */
export function isLoading() {
  return _loading;
}

/** @param {boolean} on */
export function setLoading(on) {
  _loading = !!on;
}
