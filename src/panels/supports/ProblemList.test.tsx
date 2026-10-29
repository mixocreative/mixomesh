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
