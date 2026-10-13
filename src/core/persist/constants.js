// Shared constants for the persistence subsystem (single source — the façade
// and every persist/* module read these, never re-declare them).

// 3.4 (overhaul 4.1): AssetEntry gains a `source` descriptor + `displayName`,
// `project.id` is formal, and ProjectLoader.migrate() is a real version ladder.
// 3.3 separated content-addressed textureImages from texture-view AssetEntries;
// older docs load through their per-asset fileData and source-scoped rebind.
export const SCHEMA_VERSION = '3.4';
export const FILE_EXT       = '.mixo';
export const FILE_TYPES     = [{
  description: 'MIXOMESH project',
  accept: { 'application/json': [FILE_EXT] },
}];
export const RECENT_KEY      = 'recent_projects';
export const RECENT_MAX      = 10;
export const AUTOSAVE_PREFIX = 'autosave_';
export const AUTOSAVE_IMG_PREFIX = 'autosaveimg_';   // per-hash texture images (0.11); must NOT start with AUTOSAVE_PREFIX
export const SCAN_FILE_LIMIT = 4000;            // hash-scan safety cap
export const SILENT          = { silent: true };
