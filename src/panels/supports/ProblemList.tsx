/**
 * Support check findings (plan P3.4): one kit Notice per finding at the full panel width, with Show
 * and Fix on their own row below the text. While a newer job runs the list is greyed (`aria-busy`)
 * and its buttons are off; the findings stay listed until the new verdict replaces them.
 */
import { Notice } from '../../kit/index.ts';
import { useT } from '../../react/index.ts';
import { chooseTool, supportSession } from './sessionStore';
import { handlers, useSupportUi, type PanelProblem } from './supportUi';

/** How many findings the list shows; the rest are counted. */
export const PROBLEMS_SHOWN = 12;

export function problemText(tt: ReturnType<typeof useT>, p: PanelProblem): string {
  const n = p.points?.length ?? 1;
  switch (p.kind) {
    case 'island': return tt('supportPanel.problem.island');
    case 'unjudged': return tt('supportPanel.problem.unjudged');
    case 'omitted': return tt('supportPanel.problem.omitted', { n });
    case 'outside': return tt('supportPanel.problem.outside', { n });
    default: return tt('supportPanel.problem.overhang', { area: Math.round(p.area) });
  }
}

export function ProblemList({ unitName }: { unitName?: (unitId: string) => string }) {
  const tt = useT();
  const { problems, problemsStale, job, verdicts } = useSupportUi();
  // Structure notices of the latest builds (plan P5.2): brace pruning and the tree / brace fallbacks.
  const notices = Object.entries(verdicts).flatMap(([unitId, v]) => (v.fallbacks ?? []).map((f) => ({ unitId, f })));
  if (problems.length === 0 && notices.length === 0) return null;
  const grey = problemsStale || job.running;
  return (
    <section className="sp-problems" aria-label={tt('supportPanel.problems.title')} aria-busy={grey} data-stale={grey ? 'true' : 'false'}>
      <h3 className="sp-title">{tt('supportPanel.problems.title')} <small>{problems.length}</small></h3>
      {notices.map(({ unitId, f }) => (
        <div key={`${unitId}-${f}`} data-fallback={f}>
          <Notice severity="info">
            {tt(`supportPanel.fallback.${f}`)}
            <small className="sp-where">{unitName?.(unitId) ?? unitId}</small>
          </Notice>
        </div>
      ))}
      {grey && <p className="mx-hint" role="status">{tt('supportPanel.problems.stale')}</p>}
      <div className={grey ? 'sp-grey' : undefined}>
        {problems.slice(0, PROBLEMS_SHOWN).map((p, i) => {
          const actions = p.kind === 'unjudged' || grey ? [] : [
            { label: tt('supportPanel.problems.show'), onClick: () => handlers.showProblem?.(p) },
            ...(p.kind === 'outside' ? [] : [{
              label: tt('supportPanel.problems.fix'),
              // Fix opens the Add tool with a click that adds (a Remove left on would take supports away).
              onClick: () => { chooseTool(supportSession, 'add'); supportSession.send({ type: 'setAddAction', action: 'add' }); (handlers.fixProblem ?? handlers.showProblem)?.(p); },
            }]),
          ];
          return (
            <Notice key={`${p.unitId}-${i}`} severity={p.kind === 'unjudged' ? 'info' : 'warn'} actions={actions}>
              {problemText(tt, p)}
              <small className="sp-where">
                {unitName?.(p.unitId) ?? p.unitId}
                {p.inZone ? ` · ${tt('supportPanel.problems.inZone')}` : ''}
              </small>
            </Notice>
          );
        })}
      </div>
      {problems.length > PROBLEMS_SHOWN && <p className="mx-hint">{tt('supportPanel.problems.more', { n: problems.length - PROBLEMS_SHOWN })}</p>}
    </section>
  );
}
