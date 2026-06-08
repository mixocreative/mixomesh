import { triggerDownload } from './Download.js';

export async function packageAndDownload(out, fmtLabel, progress) {
  let blob;
  if (out.kind === 'zip') {
    progress(0.9, 'Packaging…');
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    for (const e of out.entries) zip.file(e.path, e.data);
    blob = await zip.generateAsync({ type: 'blob', mimeType: out.mime });
  } else {
    blob = out.data instanceof Blob
      ? out.data
      : new Blob([out.data], { type: out.mime || 'application/octet-stream' });
  }
  progress(0.98, 'Downloading…');
  const ext = (out.filename.split('.').pop() || '').toLowerCase();
  await triggerDownload(blob, out.filename, { mime: out.mime, ext, description: `${fmtLabel} file` });
}
