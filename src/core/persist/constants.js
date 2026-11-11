// Shared constants for the persistence subsystem (single source — the façade
// and every persist/* module read these, never re-declare them).

// 3.6 (supports P4.1): `sceneObjects[].supports` — Support Mode work per logical object.
// 3.5 (marketplace publish PB.8): `project.listings[]` — listing records, no
// secrets, no bytes. Older docs migrate to an empty list.
// 3.4 (overhaul 4.1): AssetEntry gains a `source` descriptor + `displayName`,
// `project.id` is formal, and ProjectLoader.migrate() is a real version ladder.
// 3.3 separated content-addressed textureImages from texture-view AssetEntries;
// older docs load through their per-asset fileData and source-scoped rebind.
export const SCHEMA_VERSION = '3.6';
export const FILE_EXT       = '.mixo';
export const FILE_TYPES     = [{
  description: 'MIXOMESH project',
  accept: { 'application/json': [FILE_EXT] },
}];
export const RECENT_KEY      = 'recent_projects';
export const RECENT_MAX      = 10;
export const AUTOSAVE_PREFIX = 'autosave_';
export const AUTOSAVE_IMG_PREFIX = 'autosaveimg_';   // per-hash texture images (0.11); must NOT start with AUTOSAVE_PREFIX
// A snapshot a recovery attempt could not load (cia MX-02). Same rule as the
// image prefix: it must NOT start with AUTOSAVE_PREFIX, or the boot scan would
// offer it again and every launch would repeat the failure.
export const AUTOSAVE_FAILED_PREFIX = 'autosavefailed_';
export const SCAN_FILE_LIMIT = 4000;            // hash-scan safety cap
export const SILENT          = { silent: true };
