// STL / 3MF import worker (heavy-mesh spec §7.3). Reads the blob URL itself
// (the bytes never touch the UI thread), parses + welds (STL) or stream-parses
// the model parts (3MF), and transfers typed arrays back. Per-job worker: its
// whole heap is released when the job settles.

import JSZip from 'jszip';
import { serveTask, transferable } from './serveTask.js';
import { readUrl, importStlBuffer, importThreeMFBuffer } from '../import/meshImportCore.js';

serveTask(async ({ kind, blobUrl, triangleLimit }, { progress }) => {
  const stage = (lo, hi) => (e) => progress({ stage: e.stage, fraction: lo + (hi - lo) * (e.fraction ?? 0) });
  const buffer = await readUrl(blobUrl, stage(0, 0.25));
  if (kind === 'stl') {
    const { result, transfer } = importStlBuffer(buffer, stage(0.25, 1));
    return transferable(result, transfer);
  }
  if (kind === '3mf') {
    const { result, transfer } = await importThreeMFBuffer(buffer, { JSZip, triangleLimit, progress: stage(0.25, 1) });
    return transferable(result, transfer);
  }
  throw new Error(`Unsupported worker import: ${kind}`);
});
