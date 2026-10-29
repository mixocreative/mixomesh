import { t } from '../i18n/index.js';
import { PROGRESS_STAGE, type ProgressStage } from '@mixo-geocore/host/core/progress';

/**
 * The engine host reports progress as stage codes (shared packages carry no English). This maps
 * each code to its translated line; an unknown code (a newer engine host) comes back unchanged
 * so a progress row never goes blank.
 */
const LABELS: Record<ProgressStage, () => string> = {
  [PROGRESS_STAGE.writingStl]: () => t('supports.progress.writingStl'),
  [PROGRESS_STAGE.samplingNormals]: () => t('supports.progress.samplingNormals'),
  [PROGRESS_STAGE.findingOverhangs]: () => t('supports.progress.findingOverhangs'),
  [PROGRESS_STAGE.done]: () => t('supports.progress.done'),
};

export function progressLabel(stage: string): string {
  return (LABELS as Record<string, (() => string) | undefined>)[stage]?.() ?? stage;
}
