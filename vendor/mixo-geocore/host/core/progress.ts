/**
 * Progress stages reported by the engine host. They are codes, not text: the app maps each one to a
 * translated string (mixomesh locale keys carry the same names), so shared code never holds English.
 */
export const PROGRESS_STAGE = {
  writingStl: 'supports.progress.writingStl',
  samplingNormals: 'supports.progress.samplingNormals',
  findingOverhangs: 'supports.progress.findingOverhangs',
  done: 'supports.progress.done',
} as const;

export type ProgressStage = (typeof PROGRESS_STAGE)[keyof typeof PROGRESS_STAGE];
