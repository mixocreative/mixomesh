// Stable project identity (task 0.11). Autosave keys hang off this id, not the
// project name — a rename, two projects with the same name, or "Untitled"
// collisions can no longer cross-wire recovery. Minted on New / Save As / any
// load of a document without one; carried in the .mixo `project.id`.

/** @returns {string} a fresh project id (uuid v4 where available). */
export function mintProjectId() {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
