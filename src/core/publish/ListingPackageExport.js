// "Save listing package…" (PB.7): write a ListingPackage to disk with no
// network, so it works on every tier (desktop, browser, OPFS).
//
// FORMAT DECISION: one `<title>.listbridge.zip` containing `listing.json`
// (toManifest) + `images/<name>` + `files/<name>`. The StorageAdapter has no
// directory-write on every tier (OPFS/Safari have no folder picker), but
// `saveExport(blob, name, hint)` exists on all three, so a single zip goes
// through the normal save path everywhere. The zip layout is exactly what
// fromManifest's reader expects, so it re-imports losslessly.

import { toManifest, fromManifest } from '../../listbridge/index.js';

async function loadZip(deps) {
  if (deps?.JSZip) return deps.JSZip;
  return (await import('jszip')).default;
}

/** Filesystem-safe file name from the listing title. */
export function listingPackageFileName(pkg) {
  const base = String(pkg?.title || 'listing').normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 80) || 'listing';
  return `${base}.listbridge.zip`;
}

/** @returns {Promise<Uint8Array>} zip bytes (listing.json + images/ + files/). */
export async function buildListingPackageZip(pkg, deps) {
  const JSZip = await loadZip(deps);
  const zip = new JSZip();
  zip.file('listing.json', JSON.stringify(toManifest(pkg), null, 2));
  for (const i of pkg.images) zip.file(`images/${i.name}`, i.bytes, { binary: true });
  for (const f of pkg.files) zip.file(`files/${f.name}`, f.bytes, { binary: true });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** Read a package zip back into a ListingPackage (round-trip / re-import). */
export async function readListingPackageZip(bytes, deps) {
  const JSZip = await loadZip(deps);
  const zip = await JSZip.loadAsync(bytes);
  const manifestFile = zip.file('listing.json');
  if (!manifestFile) throw new Error('Not a listing package: listing.json is missing.');
  const manifest = JSON.parse(await manifestFile.async('string'));
  return fromManifest(manifest, async path => {
    const entry = zip.file(path);
    if (!entry) throw new Error(`Listing package is missing ${path}.`);
    return entry.async('uint8array');
  });
}

/**
 * Hand the package zip to the active StorageAdapter's save path.
 * @returns {Promise<boolean>} false when the user cancelled the picker.
 */
export async function saveListingPackage(pkg, deps = {}) {
  const storage = deps.storage ?? (await import('../storage/StorageAdapter.js')).storage;
  const bytes = await buildListingPackageZip(pkg, deps);
  const blob = new Blob([bytes], { type: 'application/zip' });
  return storage.saveExport(blob, listingPackageFileName(pkg), {
    mime: 'application/zip', ext: 'zip', description: 'Listing package',
  });
}
