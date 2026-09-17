/**
 * Hand a blob to the user: File System Access save picker when available,
 * anchor download otherwise.
 * @returns {Promise<boolean>} true when written / handed to the browser,
 *   false when the user cancelled the picker. Callers must not report
 *   success on false (audit 2026-09-17 H6: cancel used to toast "✓ Exported").
 */
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
      return true;
    } catch (err) {
      if (err && err.name === 'AbortError') return false;
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
  return true;
}
