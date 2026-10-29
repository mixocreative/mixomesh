// Vite worker entry over the shared mesh worker body (mixo-geocore host/workers/meshWorker). The
// body serves the WorkerTask protocol; this file only points the worker at the engine glue, which
// the main thread passes in the worker URL (see loadGeometry.js `meshWorkerUrl`).
import { configureGeometry } from '@mixo-geocore/host/workers/geometryClient';
import { GEOMETRY_GLUE_PARAM } from './loadGeometry.js';
import '@mixo-geocore/host/workers/meshWorker';

const glueUrl = new URL(self.location.href).searchParams.get(GEOMETRY_GLUE_PARAM);
if (!glueUrl) throw new Error(`mesh worker started without ?${GEOMETRY_GLUE_PARAM}=<engine glue url>`);
configureGeometry(glueUrl);
