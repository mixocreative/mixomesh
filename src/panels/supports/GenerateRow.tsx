/**
 * Generate / Regenerate and the job's progress (plan P3.4). The button says Regenerate once the
 * object has a build. The worker job itself is P3.5: it registers `handlers.generate` / `cancelJob`
 * and writes `supportUi.job`; until a generator is registered the button is off.
 */
import { Button, ProgressRow } from '../../kit/index.ts';
import { useT } from '../../react/index.ts';
import { isBuilt, useSupportsRecord } from './supportData';
import { handlers, useSupportUi } from './supportUi';

export function GenerateRow({ objectIds, objectId }: { objectIds: readonly string[]; objectId: string | undefined }) {
  const tt = useT();
  const { job, verdicts } = useSupportUi();
  const verdict = objectId ? verdicts[objectId] : undefined;
  const record = useSupportsRecord(objectId);
  const built = isBuilt(record);
  const ready = typeof handlers.generate === 'function';
  return (
    <section className="sp-generate">
      <Button variant="primary" disabled={!ready || job.running || objectIds.length === 0}
        title={ready ? tt(built ? 'supportPanel.generate.regenerateHint' : 'supportPanel.generate.hint') : tt('supportPanel.generate.unavailable')}
        onClick={() => handlers.generate?.(objectIds)}>
        {tt(job.running ? 'supportPanel.generate.running' : built ? 'supportPanel.generate.regenerate' : 'supportPanel.generate.generate')}
      </Button>
      {job.running && (
        <ProgressRow label={tt(job.stageKey ?? 'supportPanel.generate.running')} {...(job.progress !== undefined ? { value: job.progress } : {})}
          cancelLabel={tt('supportPanel.generate.cancel')}
          {...(objectId && handlers.cancelJob ? { onCancel: () => handlers.cancelJob?.(objectId) } : {})} />
      )}
      {record?.stale && <p className="mx-hint" role="note">{tt('supportPanel.generate.stale')}</p>}
      {verdict && !job.running && (
        <p className="mx-hint sp-verdict" role="status" data-verdict={verdict.status}>
          {tt(`supportPanel.verdict.${verdict.status}`)}
          {verdict.dropped > 0 ? ` · ${tt('supportPanel.verdict.dropped', { n: verdict.dropped })}` : ''}
          {verdict.buried ? ` · ${tt('supportPanel.verdict.buried', { n: verdict.buried })}` : ''}
          {verdict.insideOthers ? ` · ${tt('supportPanel.verdict.insideOthers', { n: verdict.insideOthers })}` : ''}
          {verdict.noiseShells ? ` · ${tt('supportPanel.verdict.noiseShells', { n: verdict.noiseShells })}` : ''}
          {verdict.islands > 0 ? ` · ${tt('supportPanel.verdict.islands', { n: verdict.islands })}` : ''}
          {verdict.fallbacks?.map((f) => ` · ${tt(`supportPanel.fallback.${f}`)}`).join('') ?? ''}
        </p>
      )}
      {built && (
        <Button title={tt('supportPanel.removeAllHint')} disabled={!handlers.removeAll || job.running}
          onClick={() => handlers.removeAll?.(objectIds)}>
          {tt('supportPanel.removeAll')}
        </Button>
      )}
    </section>
  );
}
