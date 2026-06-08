export async function triggerDownload(blob, suggestedName, hint = {}) {
  if (typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function') {
    try {
      const mime = hint.mime || blob.type || 'application/octet-stream';
      const ext = hint.ext || (suggestedName.split('.').pop() || '');
      const accept = ext ? { [mime]: [`.${ext}`] } : { [mime]: [] };
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: hint.description || `${ext.toUpperCase()} file`, accept }],
      });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      console.error('Save dialog failed, falling back to anchor download:', err);
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = suggestedName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
