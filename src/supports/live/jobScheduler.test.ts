import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JobScheduler, type JobRequest } from './jobScheduler';

function setup() {
  const started: Array<{ id: string; job: JobRequest; finish: () => void }> = [];
  const respawn = vi.fn();
  const busy: boolean[] = [];
  const scheduler = new JobScheduler({
    run: (id, job) => new Promise<void>((resolve) => { started.push({ id, job, finish: resolve }); }),
    respawn,
    onBusy: (_id, b) => busy.push(b),
  });
  return { scheduler, started, respawn, busy };
}

const tick = async () => { await Promise.resolve(); await Promise.resolve(); };

describe('JobScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('ten rapid requests start one job after the debounce, for the last request', () => {
    const { scheduler, started } = setup();
    let last = 0;
    for (let i = 0; i < 10; i++) { last = scheduler.request('a'); vi.advanceTimersByTime(50); }
    expect(started).toHaveLength(0);
    vi.advanceTimersByTime(500);
    expect(started).toHaveLength(1);
    expect(started[0]!.job.token).toBe(last);
    expect(started[0]!.job.current()).toBe(true);
  });

  it('a request while a job runs waits; the running result goes stale; only the latest waiting one starts', async () => {
    const { scheduler, started, respawn } = setup();
    scheduler.request('a', {}, { immediate: true });
    expect(started).toHaveLength(1);
    scheduler.request('a', { placement: true }, { immediate: true });
    scheduler.request('a', {}, { immediate: true });
    expect(started).toHaveLength(1);
    expect(started[0]!.job.current()).toBe(false);
    expect(respawn).not.toHaveBeenCalled();
    started[0]!.finish();
    await tick();
    expect(started).toHaveLength(2);
    expect(started[1]!.job.placement).toBe(true);
    expect(started[1]!.job.current()).toBe(true);
  });

  it('a job past 20 s with a newer one waiting is ended (worker respawn); a younger one is not', async () => {
    const { scheduler, started, respawn } = setup();
    scheduler.request('a', {}, { immediate: true });
    vi.advanceTimersByTime(5000);
    scheduler.request('a', {}, { immediate: true });
    expect(respawn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(14_999);
    expect(respawn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(respawn).toHaveBeenCalledWith('a');
    started[0]!.finish();
    await tick();
    expect(started).toHaveLength(2);
  });

  it('a request that arrives after 20 s of running respawns at once', () => {
    const { scheduler, respawn } = setup();
    scheduler.request('a', {}, { immediate: true });
    vi.advanceTimersByTime(21_000);
    scheduler.request('a', {}, { immediate: true });
    expect(respawn).toHaveBeenCalledTimes(1);
  });

  it('objects are independent and busy follows pending, running and idle', async () => {
    const { scheduler, started, busy } = setup();
    scheduler.request('a');
    scheduler.request('b');
    expect(scheduler.isBusy('a')).toBe(true);
    vi.advanceTimersByTime(500);
    expect(started.map((s) => s.id)).toEqual(['a', 'b']);
    started[0]!.finish();
    await tick();
    expect(scheduler.isBusy('a')).toBe(false);
    expect(scheduler.isBusy('b')).toBe(true);
    expect(busy).toContain(false);
  });

  it('cancel drops pending work and ends a running job', () => {
    const { scheduler, started, respawn } = setup();
    scheduler.request('a', {}, { immediate: true });
    scheduler.request('a');
    scheduler.cancel('a');
    vi.advanceTimersByTime(1000);
    expect(started).toHaveLength(1);
    expect(started[0]!.job.current()).toBe(false);
    expect(respawn).toHaveBeenCalledWith('a');
  });
});
