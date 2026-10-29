/**
 * Progress stages reported by the engine host. They are codes, not text: the app maps each one to a
 * translated string (mixomesh locale keys carry the same names), so shared code never holds English.
 */
/** The stage codes; each value is also the app's locale key for its text. */
export const PROGRESS_STAGE = {
  writingStl: 'supports.progress.writingStl',
  samplingNormals: 'supports.progress.samplingNormals',
  findingOverhangs: 'supports.progress.findingOverhangs',
  done: 'supports.progress.done',
} as const;

/** One of the `PROGRESS_STAGE` codes. */
export type ProgressStage = (typeof PROGRESS_STAGE)[keyof typeof PROGRESS_STAGE];
