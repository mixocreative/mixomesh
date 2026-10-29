// Vite worker entry for support placement and checks (plan P3.5). Same engine glue handshake as
// meshWorker.entry.ts; one job at a time (the client never sends a second before the first answers).
// A .js file on purpose: the dev server picks the language from the END of the worker URL, which
// carries the engine glue URL (`...mixo_geometry_wasm.js`), so TypeScript syntax in a worker entry
// fails to parse in dev. The task shapes live in analysisProtocol.ts.
import { configureGeometry, geometryReady } from '@mixo-geocore/host/workers/geometryClient';
import { runCheckJob, runPlacementJob } from '@mixo-geocore/host/supports/jobRunner';
import { runAfterGeometryReady } from '@mixo-geocore/host/geometryVersion.js';
import { serveTask, transferable } from '@mixo-geocore/host/workers/serveTask';
import { GEOMETRY_GLUE_PARAM } from './loadGeometry.js';

const glueUrl = new URL(self.location.href).searchParams.get(GEOMETRY_GLUE_PARAM);
if (!glueUrl) throw new Error(`analysis worker started without ?${GEOMETRY_GLUE_PARAM}=<engine glue url>`);
configureGeometry(glueUrl);

const PROGRESS_INTERVAL_MS = 60;

serveTask((task, { progress: post }) => runAfterGeometryReady(geometryReady, () => {
  let last = 0;
  const progress = (fraction, stage) => {
    const now = performance.now();
    if (now - last < PROGRESS_INTERVAL_MS && fraction < 1) return;
    last = now;
    post({ fraction, stage });
  };
  if (task.kind === 'check') return { kind: 'checked', problems: runCheckJob(task.job, progress) };
  const result = runPlacementJob(task.job, progress);
  return transferable({ kind: 'placed', result }, [result.contactPositions.buffer, result.contactNormals.buffer]);
}));
