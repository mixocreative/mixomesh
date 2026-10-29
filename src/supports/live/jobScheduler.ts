/**
 * Per-object job scheduling of live support generation (plan P3.5, directive D15), framework-free.
 *
 *  - requests are debounced (`debounceMs`, default 0.5 s) unless `immediate`;
 *  - one job runs per object; a request made while one runs waits, and only the LATEST request per
 *    object is kept (the intents merge: a placement request is never lost to a later plain rebuild);
 *  - a job that has run past `respawnMs` (20 s) while a newer request waits is ended through
 *    `respawn(objectId)` (the host terminates and respawns the worker); a younger job is left to
 *    finish, then the waiting request starts at once;
 *  - every job carries a `token`; `current()` tells it whether a newer request was made since, so it
 *    drops a stale result instead of delivering it.
 */
export const DEBOUNCE_MS = 500;
export const RESPAWN_AFTER_MS = 20_000;

export interface JobRequest {
  token: number;
  /** A fresh automatic placement is wanted (else the existing placement is rebuilt). */
  placement: boolean;
  /** False once a newer request for the object was made. */
  current(): boolean;
}

export interface Intent { placement?: boolean }

export interface SchedulerOptions {
  run(objectId: string, job: JobRequest): Promise<void>;
  /** End the running job of `objectId` by terminating and respawning its worker. */
  respawn(objectId: string): void;
  /** Busy flag of an object changed (a request is pending, waiting or running). */
  onBusy?(objectId: string, busy: boolean): void;
  debounceMs?: number;
  respawnMs?: number;
}

interface Slot {
  seq: number;
  want: { placement: boolean } | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  running: { token: number; startedAt: number } | undefined;
  respawnTimer: ReturnType<typeof setTimeout> | undefined;
  busy: boolean;
}

export class JobScheduler {
  private readonly slots = new Map<string, Slot>();
  private readonly debounceMs: number;
  private readonly respawnMs: number;

  constructor(private readonly options: SchedulerOptions) {
    this.debounceMs = options.debounceMs ?? DEBOUNCE_MS;
    this.respawnMs = options.respawnMs ?? RESPAWN_AFTER_MS;
  }

  private slot(id: string): Slot {
    let s = this.slots.get(id);
    if (!s) this.slots.set(id, (s = { seq: 0, want: undefined, timer: undefined, running: undefined, respawnTimer: undefined, busy: false }));
    return s;
  }

  private setBusy(id: string, s: Slot): void {
    const busy = s.want !== undefined || s.running !== undefined || s.timer !== undefined;
    if (busy !== s.busy) {
      s.busy = busy;
      this.options.onBusy?.(id, busy);
    }
  }

  isBusy(id: string): boolean {
    return this.slots.get(id)?.busy ?? false;
  }

  /** Ask for a job of `id`. Returns the token of the request. */
  request(id: string, intent: Intent = {}, { immediate = false }: { immediate?: boolean } = {}): number {
    const s = this.slot(id);
    const token = ++s.seq;
    s.want = { placement: (s.want?.placement ?? false) || !!intent.placement };
    clearTimeout(s.timer);
    s.timer = undefined;
    if (immediate) this.flush(id);
    else {
      s.timer = setTimeout(() => { s.timer = undefined; this.flush(id); }, this.debounceMs);
      this.setBusy(id, s);
    }
    return token;
  }

  /** Forget everything of `id` (object removed, mode left): pending requests are dropped, a running job ends. */
  cancel(id: string): void {
    const s = this.slots.get(id);
    if (!s) return;
    s.seq++;
    s.want = undefined;
    clearTimeout(s.timer);
    s.timer = undefined;
    clearTimeout(s.respawnTimer);
    s.respawnTimer = undefined;
    if (s.running) this.options.respawn(id);
    this.setBusy(id, s);
  }

  private flush(id: string): void {
    const s = this.slot(id);
    if (!s.want) { this.setBusy(id, s); return; }
    if (s.running) {
      const age = Date.now() - s.running.startedAt;
      clearTimeout(s.respawnTimer);
      const running = s.running;
      const end = () => { if (s.running === running && s.want) this.options.respawn(id); };
      if (age >= this.respawnMs) end();
      else s.respawnTimer = setTimeout(end, this.respawnMs - age);
      this.setBusy(id, s);
      return;
    }
    const want = s.want;
    s.want = undefined;
    const token = s.seq;
    const running = { token, startedAt: Date.now() };
    s.running = running;
    this.setBusy(id, s);
    const job: JobRequest = { token, placement: want.placement, current: () => s.seq === token };
    const done = () => {
      if (s.running !== running) return;
      s.running = undefined;
      clearTimeout(s.respawnTimer);
      s.respawnTimer = undefined;
      if (s.want && s.timer === undefined) this.flush(id);
      this.setBusy(id, s);
    };
    this.options.run(id, job).then(done, done);
  }
}
