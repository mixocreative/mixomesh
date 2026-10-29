import type { StatusMessage } from './types';

/** The code the Rust engine gives when it is over capacity (`OVER_CAPACITY` in SHIP-PLAN; `MeshError::Capacity`, `StlError::Capacity`). */
export const ENGINE_OVER_CAPACITY = 'CAPACITY';

/** What went wrong, independent of the language it is shown in. */
export const ERROR_CODES = ['non-finite', 'no-mesh', 'file-type', 'bad-stl', 'too-large', 'out-of-memory', 'plate-full', 'over-capacity', 'timeout', 'worker-stopped', 'unknown'] as const;
export type ErrorCode = typeof ERROR_CODES[number];

/** The job that failed. */
export const ERROR_CONTEXTS = ['import', 'place', 'build', 'check', 'export'] as const;
export type ErrorContext = typeof ERROR_CONTEXTS[number];

/** An error that carries its code (and the numbers its message needs), so the host can translate it. */
export class CodedError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly vars: Record<string, string | number> = {}) {
    super(message);
    this.name = 'CodedError';
  }
}

/**
 * The code of an error: a CodedError's own, else recognised from the errors thrown today
 * (`state/import.ts` non-finite check, the import worker crash, a timeout by name or message).
 */
export function errorCode(error: unknown): ErrorCode {
  if (error instanceof CodedError) return error.code;
  if (!(error instanceof Error)) return 'unknown';
  // The geometry engine's own refusal (wasm code CAPACITY: more meshes, triangles or ids than it can address).
  if ((error as { code?: unknown }).code === ENGINE_OVER_CAPACITY) return 'over-capacity';
  if (error.name === 'TimeoutError' || /\btimed? ?out\b/i.test(error.message)) return 'timeout';
  if (/vertex coordinates that are not finite/i.test(error.message)) return 'non-finite';
  if (/contains no mesh/i.test(error.message)) return 'no-mesh';
  // A worker crash: "The import worker stopped.", "The analysis worker stopped.", "… failed in the background worker."
  if (/\bworker (stopped|failed)\b|failed in the background worker/i.test(error.message)) return 'worker-stopped';
  return 'unknown';
}

// Each message says what happened, then what to do next. Keys are i18n keys (src/i18n.ts).
const IMPORT: Record<ErrorCode, string> = {
  'non-finite': '{name} has broken vertex positions (not numbers). Repair the model or export it again, then import it.',
  'no-mesh': '{name} contains no mesh. Export it again with the mesh included, then import it.',
  'file-type': 'Only STL, GLB and glTF files can be imported. Choose a file of one of these types.',
  'bad-stl': '{name} is a damaged STL file: its size does not match its triangles. Export it again, then import it.',
  'too-large': '{name} is too large to edit here: {n} triangles, the limit is {limit}. Simplify the model, then import it again.',
  'out-of-memory': '{name} ({n} triangles) needs more memory than this device can give the editor. Simplify or split the model, then import it again.',
  'plate-full': 'The plate would hold {n} triangles with {name}; the limit is {limit}. Delete or simplify an object first, then import again.',
  'over-capacity': 'The geometry engine cannot hold {name} on top of what is on the plate. Remove or simplify an object, or simplify the model, then import it again.',
  timeout: 'Importing {name} took too long and was stopped. Try again; if it happens again, simplify the model.',
  'worker-stopped': 'The import stopped unexpectedly while reading {name}. Import it again; if it stops again, the file may be too large or damaged: simplify it or export it again.',
  unknown: 'Could not read {name} as STL, GLB or glTF ({error}). Check the file or export it again, then import it.',
};
const TIMEOUT: Record<Exclude<ErrorContext, 'import'>, string> = {
  place: 'Placing contacts took too long and was stopped. Generate again, or raise Support spacing for fewer contacts.',
  build: 'Building supports took too long and was stopped. Change a setting or generate again to retry.',
  check: 'The support check took too long and was stopped. Supports are unchanged; run the check again.',
  export: 'Export took too long and was stopped. Nothing was saved; try again, or export one object at a time.',
};
// A crashed worker is replaced by a fresh one on the next request, so the next step is to retry
// (never to reload the page, which would lose the unsaved scene).
const STOPPED: Record<Exclude<ErrorContext, 'import'>, string> = {
  place: 'The support worker stopped unexpectedly. Supports are unchanged; generate again.',
  build: 'The support worker stopped unexpectedly. Change a setting or generate again to rebuild the supports.',
  check: 'The support worker stopped unexpectedly. Supports are unchanged; run the check again.',
  export: 'The export worker stopped unexpectedly. Nothing was saved; export again.',
};
const FAILED: Record<Exclude<ErrorContext, 'import'>, string> = {
  place: 'Placing contacts failed ({error}). Adjust the model or settings, then generate again.',
  build: 'Building supports failed ({error}). Change a setting or generate again to retry.',
  check: 'The support check failed ({error}). Supports are unchanged; run the check again.',
  export: 'Export failed ({error}). Nothing was saved; try again, or export one object at a time.',
};

// Memory refusals outside import: Generate checks what the jobs would need before it starts.
const OVER_CAPACITY = 'The geometry engine is full: the plate holds more than it can handle at once. Remove or simplify an object, then try again.';
const MEMORY = 'Generating supports for {n} triangles at once needs more memory than this device can give the editor. Generate fewer objects at a time, or simplify the models.';

/** The status line for a failed job. `name` is the file (import) or object concerned. */
export function errorStatus(context: ErrorContext, error: unknown, vars: { name?: string } = {}): StatusMessage {
  const code = errorCode(error);
  const coded = error instanceof CodedError ? error.vars : {};
  const raw = error instanceof Error ? error.message : String(error);
  let key: string;
  if (context === 'import') key = IMPORT[code];
  else key = code === 'timeout' ? TIMEOUT[context] : code === 'worker-stopped' ? STOPPED[context] : code === 'out-of-memory' ? MEMORY : code === 'over-capacity' ? OVER_CAPACITY : FAILED[context];
  const filled: Record<string, string | number> = { ...(vars.name !== undefined ? { name: vars.name } : {}), ...coded };
  // The raw message only fills a message that asks for it (errors the app does not know yet).
  if (key.includes('{error}')) filled.error = raw;
  return Object.keys(filled).length ? { key, vars: filled } : { key };
}
