// Name-clash display rules (BLUEPRINT §8 / overhaul §4.4 rules 3–4, task 4.8).
//
// Pure functions over the persisted AssetEntry fields only (displayName /
// filename / name, source.path / source.label / originalPath, kind,
// isImported, sourceAssetId) plus assetLibrary ORDER — so a qualified name is
// identical before and after a save → reload. Nothing here renames a user
// file or writes state: the stored `displayName` stays the user-facing base
// name; qualification is computed at display time, only while ambiguous.
//
//   rule 3  same label, different asset → each is qualified VS Code style by
//           the shortest distinguishing parent-folder suffix
//           (`chair.glb · downloads`); still tied (no folder, or identical
//           folders) → ` #2`, ` #3` … by library order, the first stays plain.
//   rule 4  generic texture names (baseColor, albedo, diffuse, Image_N,
//           textureN, tex_N, material_N) display as `<model> · <slot>`;
//           the original name goes in the tooltip.

/** §4.4 rule 4 — generic image names that say nothing about the model. */
export const GENERIC_TEXTURE_NAME_RE = /^(?:baseColor|albedo|diffuse|Image_\d+|texture\d*|tex_\d+|material_\d+)$/i;

/** Slot label for imported textures — only the base-colour image is imported. */
export const IMPORTED_TEXTURE_SLOT = 'baseColor';

const SEP = ' · ';
const _cache = new WeakMap();   // assetLibrary object → Map<assetId, DisplayName>

/**
 * @typedef {{ label: string, qualifier: string, text: string, tooltip: string,
 *             generic: boolean }} DisplayName
 *   label     — unqualified display label (rule 4 already applied)
 *   qualifier — '' when unambiguous; else folder suffix and/or `#N`
 *   text      — what a card / Outliner row shows: `label · qualifier` or `label`
 *   tooltip   — the original stored name (+ source path when known)
 *   generic   — label came from rule 4
 */

function _stem(name) {
  return String(name ?? '').replace(/\.[^./\\\s]+$/, '');
}

/** Stored base name — mirrors ProjectSerializer.deriveDisplayName. */
export function rawDisplayName(asset) {
  if (!asset) return '';
  return (typeof asset.displayName === 'string' && asset.displayName)
    || asset.filename || asset.name || asset.id || '';
}

/** True when `name` (extension ignored) is a §4.4 rule-4 generic texture name. */
export function isGenericTextureName(name) {
  const stem = _stem(name).trim();
  return !!stem && GENERIC_TEXTURE_NAME_RE.test(stem);
}

function _sourcePath(asset) {
  const p = asset?.source?.path || asset?.originalPath || '';
  return String(p);
}

/**
 * Parent-folder chain, deepest first: `kits/parts/chair.glb` under mount
 * `Library` → ['parts', 'kits', 'Library'].
 */
function _folderChain(asset) {
  const segs = _sourcePath(asset).split(/[\\/]/).filter(Boolean);
  segs.pop();                                   // the file itself
  const chain = segs.reverse();
  const label = asset?.source?.label;
  if (typeof label === 'string' && label
      && chain[chain.length - 1]?.toLowerCase() !== label.toLowerCase()) {
    chain.push(label);
  }
  return chain;
}

function _baseLabel(asset, library) {
  const raw = rawDisplayName(asset);
  if (asset?.kind === 'texture' && asset.sourceAssetId && isGenericTextureName(raw)) {
    const model = library?.[asset.sourceAssetId];
    if (model) {
      return { label: `${_stem(rawDisplayName(model))}${SEP}${IMPORTED_TEXTURE_SLOT}`, generic: true, model };
    }
  }
  return { label: raw, generic: false, model: null };
}

function _suffix(chain, k) {
  return chain.slice(0, k).reverse().join('/');
}

/**
 * Qualify every asset in `assetLibrary` (rule 3 + rule 4). Memoised per
 * library object — StateManager replaces the object on every change.
 * @param {Record<string, object>} assetLibrary
 * @returns {Map<string, DisplayName>}
 */
export function qualifyDisplayNames(assetLibrary) {
  const lib = assetLibrary ?? {};
  const hit = _cache.get(lib);
  if (hit) return hit;

  const rows = Object.values(lib).filter(Boolean).map((asset, order) => {
    const { label, generic, model } = _baseLabel(asset, lib);
    // A generic texture lives inside its model — it inherits the model's folders.
    const chain = _folderChain(model ?? asset);
    return { asset, order, label, generic, chain, folder: '', ordinal: 0 };
  });

  const byLabel = new Map();
  for (const row of rows) {
    const key = row.label.toLowerCase();
    if (!byLabel.has(key)) byLabel.set(key, []);
    byLabel.get(key).push(row);
  }

  for (const peers of byLabel.values()) {
    if (peers.length < 2) continue;
    // VS Code style: the shortest parent-folder suffix no peer shares.
    for (const row of peers) {
      for (let k = 1; k <= row.chain.length; k++) {
        const mine = _suffix(row.chain, k).toLowerCase();
        if (peers.every(p => p === row || _suffix(p.chain, k).toLowerCase() !== mine)) {
          row.folder = _suffix(row.chain, k);
          break;
        }
      }
      if (!row.folder && row.chain.length) row.folder = _suffix(row.chain, row.chain.length);
    }
    // Still tied (same folder text, or none) → ordinal by library order.
    const tied = new Map();
    for (const row of peers) {
      const key = row.folder.toLowerCase();
      if (!tied.has(key)) tied.set(key, []);
      tied.get(key).push(row);
    }
    for (const group of tied.values()) {
      if (group.length < 2) continue;
      group.sort((a, b) => a.order - b.order);
      group.forEach((row, i) => { if (i > 0) row.ordinal = i + 1; });
    }
  }

  const out = new Map();
  for (const row of rows) {
    const parts = [];
    if (row.folder) parts.push(row.folder);
    if (row.ordinal) parts.push(`#${row.ordinal}`);
    const qualifier = parts.join(' ');
    const raw = rawDisplayName(row.asset);
    const path = _sourcePath(row.asset);
    out.set(row.asset.id, {
      label: row.label,
      qualifier,
      text: qualifier ? `${row.label}${SEP}${qualifier}` : row.label,
      tooltip: path && path !== raw ? `${raw} — ${path}` : raw,
      generic: row.generic,
    });
  }
  _cache.set(lib, out);
  return out;
}

/**
 * Display parts for one asset (for the mockup-gated card / Outliner UI).
 * @param {string|object} assetOrId
 * @param {Record<string, object>} assetLibrary
 * @returns {DisplayName|null}
 */
export function displayNameParts(assetOrId, assetLibrary) {
  const id = typeof assetOrId === 'string' ? assetOrId : assetOrId?.id;
  if (!id) return null;
  return qualifyDisplayNames(assetLibrary).get(id) ?? null;
}

/**
 * The text a card / Outliner row shows: `chair.glb`, `chair.glb · downloads`,
 * `chair.glb #2`, `chair · baseColor`.
 * @param {string|object} assetOrId
 * @param {Record<string, object>} assetLibrary
 * @returns {string}
 */
export function qualifiedDisplayName(assetOrId, assetLibrary) {
  const parts = displayNameParts(assetOrId, assetLibrary);
  if (parts) return parts.text;
  return typeof assetOrId === 'object' ? rawDisplayName(assetOrId) : String(assetOrId ?? '');
}
