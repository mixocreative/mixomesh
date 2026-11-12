import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { renderPanel, resetWorld } from './testHarness';
import { ProblemList } from './ProblemList';
import { GenerateRow } from './GenerateRow';
import { ViewToggles } from './ViewToggles';
import { supportSession } from './sessionStore';
import { supportUi, handlers, type PanelProblem } from './supportUi';
import { record } from './testHarness';

afterEach(cleanup);
beforeEach(() => resetWorld());

const island: PanelProblem = { kind: 'island', position: [0, 0, 0], area: 0, unitId: 'obj', inZone: false };
const overhang: PanelProblem = { kind: 'overhang', position: [1, 0, 0], area: 12.4, unitId: 'obj', inZone: true };

describe('ProblemList', () => {
  it('lists the brace-pruned notice of the latest build, and the verdict line says it too (plan P5.2)', () => {
    supportUi.set({ verdicts: { obj: { status: 'clear', dropped: 0, islands: 0, fallbacks: ['brace-pruned'] } } });
    const { container } = renderPanel(<><ProblemList unitName={() => 'Wall'} /><GenerateRow objectIds={['obj']} objectId="obj" /></>);
    const note = container.querySelector('[data-fallback="brace-pruned"]');
    expect(note?.textContent).toContain('Only the cross-braces that would cross the model were left out.');
    expect(container.querySelector('.sp-verdict')?.textContent).toContain('Only the cross-braces that would cross the model were left out.');
  });

  it('says how many contacts the overlap rule left out, and says nothing when it left none', () => {
    // The chip is the only place an operator can learn WHY an overlap has no supports. The build
    // never saw those contacts, so they are not in `dropped` and no other line mentions them.
    supportUi.set({ verdicts: { obj: { status: 'clear', dropped: 0, islands: 0, buried: 3 } } });
    const { container } = renderPanel(<GenerateRow objectIds={['obj']} objectId="obj" />);
    expect(container.querySelector('.sp-verdict')?.textContent).toContain('3 contacts inside another mesh');
    cleanup();
    supportUi.set({ verdicts: { obj: { status: 'clear', dropped: 0, islands: 0 } } });
    const quiet = renderPanel(<GenerateRow objectIds={['obj']} objectId="obj" />);
    expect(quiet.container.querySelector('.sp-verdict')?.textContent).not.toContain('inside another mesh');
  });

  it('renders nothing without findings', () => {
    const { container } = renderPanel(<ProblemList />);
    expect(container.querySelector('.sp-problems')).toBeNull();
  });

  it('one Notice per finding, actions on their own row', () => {
    supportUi.set({ problems: [island, overhang] });
    const { container } = renderPanel(<ProblemList unitName={() => 'Crown'} />);
    const notices = container.querySelectorAll('.mx-notice');
    expect(notices).toHaveLength(2);
    expect(within(notices[0] as HTMLElement).getByText('Unsupported island')).toBeTruthy();
    expect(notices[1]!.textContent).toContain('12 mm²');
    expect(notices[1]!.textContent).toContain('in a no-support zone');
    const actions = notices[0]!.querySelector('.mx-notice-actions')!;
    expect(notices[0]!.querySelector('.mx-notice-text')!.contains(actions)).toBe(false);
    expect([...actions.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Show', 'Fix']);
  });

  it('Show frames the finding; Fix opens the Add tool with a click that adds', () => {
    const show = vi.fn();
    handlers.showProblem = show;
    supportSession.send({ type: 'activeUnitChanged', id: 'obj' });
    supportSession.send({ type: 'enterEdit' });
    supportSession.send({ type: 'setTool', tool: 'select' });
    supportSession.send({ type: 'setAddAction', action: 'remove' });
    supportUi.set({ problems: [island] });
    renderPanel(<ProblemList />);
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(show).toHaveBeenCalledWith(island);
    fireEvent.click(screen.getByRole('button', { name: 'Fix' }));
    expect(supportSession.get()).toMatchObject({ mode: 'edit', tool: 'add', addAction: 'add' });
  });

  it('greys while a newer job runs and takes the actions away', () => {
    supportUi.set({ problems: [island], problemsStale: true });
    const { container } = renderPanel(<ProblemList />);
    expect(container.querySelector('.sp-problems')!.getAttribute('data-stale')).toBe('true');
    expect(container.querySelector('.sp-grey')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
    act(() => supportUi.set({ problemsStale: false }));
    expect(screen.getByRole('button', { name: 'Show' })).toBeTruthy();
  });

  it('lists 12 and counts the rest; an unjudged mesh offers no action', () => {
    supportUi.set({ problems: Array.from({ length: 15 }, () => island) });
    const { container } = renderPanel(<ProblemList />);
    expect(container.querySelectorAll('.mx-notice')).toHaveLength(12);
    expect(screen.getByText('and 3 more')).toBeTruthy();
    cleanup();
    supportUi.set({ problems: [{ ...island, kind: 'unjudged' }] });
    renderPanel(<ProblemList />);
    expect(screen.queryByRole('button', { name: 'Show' })).toBeNull();
  });
});

describe('GenerateRow', () => {
  it('is off until a generator is registered, then runs it for the mode objects', () => {
    renderPanel(<GenerateRow objectIds={['obj']} objectId="obj" />);
    const button = screen.getByRole('button', { name: 'Generate supports' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    cleanup();
    const generate = vi.fn();
    handlers.generate = generate;
    renderPanel(<GenerateRow objectIds={['obj']} objectId="obj" />);
    fireEvent.click(screen.getByRole('button', { name: 'Generate supports' }));
    expect(generate).toHaveBeenCalledWith(['obj']);
  });

  it('says Regenerate once built and shows the job progress', () => {
    resetWorld({ ...record(), sourceHash: 'h', pose: { rotation: [0, 0, 0, 1], scale: [1, 1, 1] } });
    handlers.generate = vi.fn();
    handlers.cancelJob = vi.fn();
    supportUi.set({ job: { running: true, progress: 0.4, stageKey: 'supports.progress.findingOverhangs' } });
    renderPanel(<GenerateRow objectIds={['obj']} objectId="obj" />);
    expect((screen.getByRole('button', { name: 'Generating supports…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('0.4');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(handlers.cancelJob).toHaveBeenCalledWith('obj');
    act(() => supportUi.set({ job: { running: false } }));
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeTruthy();
  });
});

describe('ViewToggles', () => {
  it('Tips only is the object preview mode; Bottom view and Fit view call the camera seams', () => {
    const bottom = vi.fn();
    const fit = vi.fn();
    handlers.setBottomView = bottom;
    handlers.fitView = fit;
    renderPanel(<ViewToggles objectId="obj" />);
    const tips = screen.getByRole('button', { name: 'Tips only' });
    expect(tips.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(tips);
    expect(record().settings.previewMode).toBe('ONLY_TIP');
    expect(screen.getByRole('button', { name: 'Tips only' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Bottom view' }));
    expect(bottom).toHaveBeenCalledWith(true);
    expect(supportUi.get().bottomView).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Fit view' }));
    expect(fit).toHaveBeenCalled();
  });
});

describe('every verdict the UI can show has a sentence in every locale', () => {
  it('covers each status, because the key is built from a template and the scanner cannot see it', async () => {
    // `GenerateRow` renders `supportPanel.verdict.${verdict.status}`. `npm run i18n:check` reports
    // 0 gaps for a missing one, because it looks for literal keys and this one is interpolated --
    // so it would have let `nothing-built` ship untranslated. Assert the four by hand instead.
    const statuses = ['clear', 'blocked', 'inconclusive', 'nothing-built'] as const;
    // `verdict.buried` and `verdict.dropped` ARE literal keys, so `i18n:check` sees them; they are
    // here anyway because they sit on the same line and a locale that loses one loses the sentence.
    const chips = ['dropped', 'islands', 'buried'] as const;
    for (const lang of ['en', 'ja', 'zh-Hant'] as const) {
      const dict = (await import(`../../i18n/locales/${lang}.json`)).default as Record<string, string>;
      for (const key of [...statuses, ...chips]) {
        expect(dict[`supportPanel.verdict.${key}`], `${lang} is missing ${key}`).toBeTruthy();
      }
    }
  });
});
