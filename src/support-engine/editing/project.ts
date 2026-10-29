import type { StatusMessage } from './types';

export type ProjectErrorCode = 'not-project' | 'newer' | 'damaged';

/** A project file that cannot be opened: what is wrong with it, and the numbers its message needs. */
export class ProjectFileError extends Error {
  constructor(readonly code: ProjectErrorCode, message: string, readonly vars: Record<string, string | number> = {}) {
    super(message);
    this.name = 'ProjectFileError';
  }
}

/** Status lines of Save project and Open project. Keys are i18n keys (src/i18n.ts). */

export const savedStatus = (name: string): StatusMessage => ({ key: 'Saved {name}.', vars: { name } });
/** Shown in place of the opened line when model files were dropped together with the project. */
export const MODELS_IGNORED: StatusMessage = { key: 'Open the project alone; models were not imported.' };
export const openedStatus = (name: string): StatusMessage => ({ key: 'Opened {name}.', vars: { name } });

/** A project too big for this device's plate, found before it replaces anything. */
export class ProjectTooLarge extends Error {
  /** Carried across a worker boundary (serveTask sends `code` and `vars`), so the client can rebuild this error. */
  readonly code = 'project-too-large';
  readonly vars: { n: number; limit: number };
  constructor(readonly triangles: number, readonly limit: number) {
    super(`${triangles} triangles over the limit ${limit}`);
    this.vars = { n: triangles, limit };
  }
}

/** Why a project could not be opened, and what to do next. */
export function openFailure(error: unknown, name: string): StatusMessage {
  if (error instanceof ProjectTooLarge) return { key: '{name} is too large to open here: {n} triangles, the limit is {limit}. Open it on a device with more memory, or delete or simplify an object and save it again.', vars: { name, n: error.triangles.toLocaleString(), limit: error.limit.toLocaleString() } };
  if (error instanceof ProjectFileError) {
    if (error.code === 'not-project') return { key: '{name} is not a Mixo Supports project. Choose a .mixosupports file, or use Import models for STL, GLB and glTF.', vars: { name } };
    if (error.code === 'newer') return { key: '{name} was saved by a newer version of Mixo Supports (file version {v}; this one reads up to {max}). Update the app, then open it again.', vars: { name, v: error.vars.v ?? 0, max: error.vars.max ?? 0 } };
    return { key: '{name} is damaged and could not be read ({error}). Open another copy of the project.', vars: { name, error: error.message } };
  }
  return { key: 'Could not open {name} ({error}). The plate is unchanged.', vars: { name, error: error instanceof Error ? error.message : String(error) } };
}

export function saveFailure(error: unknown, name: string): StatusMessage {
  return { key: 'Could not save {name} ({error}). Nothing was written; try again.', vars: { name, error: error instanceof Error ? error.message : String(error) } };
}

export const SAVE_CANCELLED: StatusMessage = { key: 'Save cancelled; no file was written.' };
