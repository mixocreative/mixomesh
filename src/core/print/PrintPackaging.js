import { triggerDownload } from './Download.js';
import { t } from '../../i18n/index.js';

/**
 * Serializer output -> one Blob (zip for multi-entry formats). Shared by the
 * download path and the in-memory collect path (publish) so there is ONE
 * packager.
 */
export async function buildExportBlob(out, progress = () => {}) {
  if (out.kind === 'zip') {
    progress(0.9, t('progress.packaging'));
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const e of uniqueEntryPaths(out.entries)) zip.file(e.path, e.data);
    return zip.generateAsync({ type: 'blob', mimeType: out.mime });
  }
  return out.data instanceof Blob
    ? out.data
    : new Blob([out.data], { type: out.mime || 'application/octet-stream' });
}

/**
 * Package serializer output and hand it to the save picker / download.
 * @returns {Promise<boolean>} true when bytes were written, false when the
 *   user cancelled the save picker (callers must NOT report success).
 */
export async function packageAndDownload(out, fmtLabel, progress) {
  const blob = await buildExportBlob(out, progress);
  progress(0.98, t('progress.downloading'));
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
