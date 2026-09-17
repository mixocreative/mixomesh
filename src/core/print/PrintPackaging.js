import { triggerDownload } from './Download.js';

/**
 * Package serializer output and hand it to the save picker / download.
 * @returns {Promise<boolean>} true when bytes were written, false when the
 *   user cancelled the save picker (callers must NOT report success).
 */
export async function packageAndDownload(out, fmtLabel, progress) {
  let blob;
  if (out.kind === 'zip') {
    progress(0.9, 'Packaging…');
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const e of uniqueEntryPaths(out.entries)) zip.file(e.path, e.data);
    blob = await zip.generateAsync({ type: 'blob', mimeType: out.mime });
  } else {
    blob = out.data instanceof Blob
      ? out.data
      : new Blob([out.data], { type: out.mime || 'application/octet-stream' });
  }
  progress(0.98, 'Downloading…');
  const ext = (out.filename.split('.').pop() || '').toLowerCase();
  return triggerDownload(blob, out.filename, { mime: out.mime, ext, description: `${fmtLabel} file` });
}

/**
 * JSZip silently overwrites a repeated path, and Windows extraction is
 * case-insensitive — two parts named `Cube` and `cube`, or `a/b` and `a:b`
 * (both sanitised to `a_b`), used to leave ONE file in the zip with a success
 * toast (audit 2026-09-17 C4). Suffix repeats: `name_2.ext`, `name_3.ext`.
 * @param {Array<{path:string, data:any}>} entries
 */
export function uniqueEntryPaths(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    let path = String(e.path);
    const key = () => path.toLowerCase();
    if (seen.has(key())) {
      const dot = path.lastIndexOf('.');
      const slash = path.lastIndexOf('/');
      const stem = dot > slash ? path.slice(0, dot) : path;
      const ext = dot > slash ? path.slice(dot) : '';
      for (let n = 2; seen.has(key()); n++) path = `${stem}_${n}${ext}`;
    }
    seen.add(key());
    out.push(path === e.path ? e : { ...e, path });
  }
  return out;
}
