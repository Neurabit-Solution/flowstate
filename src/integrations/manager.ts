import type { DevState } from '../shared/types';
import type { Integration, LogEntry, StateStore } from './types';

const MAX_LOG = 200;
const FOCUS_KEY = 'manager.focusActive';

export type ManagerOptions = {
  integrations: Integration[];
  store: StateStore;
  isEnabled: (id: string) => boolean;
  onLog?: (entries: LogEntry[]) => void;
  now?: () => number;
};

/** Calls every enabled integration when focus starts and ends. One failing never stops the rest. */
export class IntegrationManager {
  private log: LogEntry[];
  private active = false;
  /** A sample's focus must end as a sample too, even if the source has already gone. */
  private activeDryRun = false;
  private queue: Promise<void> = Promise.resolve();
  private readonly now: () => number;

  constructor(private readonly options: ManagerOptions) {
    this.now = options.now ?? Date.now;
    this.log = options.store.get<LogEntry[]>('manager.log') ?? [];
  }

  get entries(): LogEntry[] {
    return this.log;
  }

  /** Feed every state change here. `dryRun` logs without acting, which is how samples run. */
  onState(state: DevState, dryRun: boolean): Promise<void> {
    const focused = state === 'focused';
    if (focused === this.active) return this.queue;
    this.active = focused;
    if (focused) this.activeDryRun = dryRun;
    const dry = this.activeDryRun;
    return this.enqueue(() => this.apply(focused ? 'enter' : 'exit', dry));
  }

  tick(): Promise<void> {
    if (!this.active || this.activeDryRun) return this.queue;
    return this.enqueue(async () => {
      if (!this.options.store.get<boolean>(FOCUS_KEY)) return;
      for (const integration of this.enabled()) {
        if (integration.onStillFocused) await this.call(integration, 'extend', () => integration.onStillFocused!());
      }
    });
  }

  /** Undoes focus left over from a crash. Call once at launch. */
  recoverFromCrash(): Promise<void> {
    if (!this.options.store.get<boolean>(FOCUS_KEY)) return this.queue;
    return this.enqueue(() => this.apply('exit', false, 'recover'));
  }

  /** Puts everything back before the app quits. */
  shutdown(): Promise<void> {
    this.active = false;
    this.activeDryRun = false;
    if (!this.options.store.get<boolean>(FOCUS_KEY)) return this.queue;
    return this.enqueue(() => this.apply('exit', false));
  }

  private enqueue(job: () => Promise<void>): Promise<void> {
    // Runs in order, so a quick exit cannot overtake the enter it follows.
    this.queue = this.queue.then(job, job);
    return this.queue;
  }

  private enabled(): Integration[] {
    return this.options.integrations.filter((i) => this.options.isEnabled(i.id) && i.ready());
  }

  private async apply(kind: 'enter' | 'exit', dryRun: boolean, label: string = kind): Promise<void> {
    if (dryRun) {
      for (const integration of this.enabled()) this.record(integration.id, `${label} (sample, not applied)`, true);
      return;
    }
    if (kind === 'enter') this.options.store.set(FOCUS_KEY, true);
    for (const integration of this.enabled()) {
      await this.call(integration, label, () => (kind === 'enter' ? integration.onEnterFocus() : integration.onExitFocus()));
    }
    if (kind === 'exit') this.options.store.delete(FOCUS_KEY);
  }

  private async call(integration: Integration, action: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
      this.record(integration.id, action, true);
    } catch (err) {
      this.record(integration.id, action, false, err instanceof Error ? err.message : String(err));
    }
  }

  private record(integration: string, action: string, ok: boolean, error?: string): void {
    this.log = [...this.log, { ts: this.now(), integration, action, ok, ...(error ? { error } : {}) }].slice(-MAX_LOG);
    this.options.store.set('manager.log', this.log);
    this.options.onLog?.(this.log);
  }
}
