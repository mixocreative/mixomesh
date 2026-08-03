// Shared constants for the persistence subsystem (single source — the façade
// and every persist/* module read these, never re-declare them).

// 3.3 separates content-addressed textureImages from texture-view AssetEntries.
// Older docs load through their per-asset fileData and source-scoped rebind.
export const SCHEMA_VERSION = '3.3';
export const FILE_EXT       = '.mixo';
export const FILE_TYPES     = [{
  description: 'MIXOMESH project',
  accept: { 'application/json': [FILE_EXT] },
}];
export const RECENT_KEY      = 'recent_projects';
export const RECENT_MAX      = 10;
export const AUTOSAVE_PREFIX = 'autosave_';
export const SCAN_FILE_LIMIT = 4000;            // hash-scan safety cap
export const SILENT          = { silent: true };
