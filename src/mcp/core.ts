// What coding agents may know: the state, how long it has held, focus minutes, and the queue
// of messages they left. It sees DevState and nothing else, so it cannot expose raw signals.
import type { DevState } from '../shared/types';

export type Priority = 'low' | 'normal' | 'urgent';
export type HeldMessage = { text: string; priority: Priority; source: string; ts: number };
export type DevStateView = { state: DevState; since: string; focusMinutesToday: number; heldMessages: number };
export type InterruptAnswer = { allow: boolean; retryAfterSeconds?: number; advice: string };
export type QueueAnswer = { queued: boolean; heldMessages: number; advice: string };
export type WaitAnswer = { available: boolean; state: DevState };
export type FocusSummary = { range: string; focusMinutes: number; blocks: number; longestBlockMinutes: number };
export type SummaryRange = 'today' | '7d';

/** The tools talk to this, so the app and the stdio bridge expose exactly the same thing. */
export interface PulseBackend {
  getDevState(): Promise<DevStateView>;
  shouldInterrupt(priority: Priority, reason?: string): Promise<InterruptAnswer>;
  queueMessage(text: string, priority: Priority, source: string): Promise<QueueAnswer>;
  waitUntilAvailable(timeoutSeconds: number): Promise<WaitAnswer>;
  getFocusSummary(range: SummaryRange): Promise<FocusSummary>;
}

const MAX_HELD = 100;
const MAX_TEXT = 2000;
const MAX_FIELD = 100;
const MAX_WAIT_SECONDS = 300;
const DAY_MS = 24 * 60 * 60_000;

/** Nobody is sensing, so there is nothing to protect. */
const isOpen = (state: DevState) => state === 'available' || state === 'off' || state === 'warming_up';

type Block = { start: number; end: number };

export type CoreOptions = {
  onDeliver?: (messages: HeldMessage[]) => void;
  onChange?: () => void;
  now?: () => number;
  /** Start of the local day containing `ms`. */
  startOfDay?: (ms: number) => number;
};

const localStartOfDay = (ms: number) => new Date(ms).setHours(0, 0, 0, 0);

export class PulseCore implements PulseBackend {
  private state: DevState = 'off';
  private since: number;
  private held: HeldMessage[] = [];
  private blocks: Block[] = [];
  private focusStart: number | null = null;
  private waiters = new Set<() => void>();
  private readonly now: () => number;
  private readonly startOfDay: (ms: number) => number;

  constructor(private readonly options: CoreOptions = {}) {
    this.now = options.now ?? Date.now;
    this.startOfDay = options.startOfDay ?? localStartOfDay;
    this.since = this.now();
  }

  get heldList(): HeldMessage[] {
    return this.held;
  }

  update(state: DevState): void {
    if (state === this.state) return;
    const now = this.now();
    if (this.state === 'focused' && this.focusStart !== null) {
      this.blocks.push({ start: this.focusStart, end: now });
      this.focusStart = null;
    }
    if (state === 'focused') this.focusStart = now;
    this.state = state;
    this.since = now;
    if (isOpen(state)) {
      this.deliver();
      for (const wake of [...this.waiters]) wake();
    }
    this.options.onChange?.();
  }

  private deliver(): void {
    if (this.held.length === 0) return;
    const messages = this.held;
    this.held = [];
    this.options.onDeliver?.(messages);
  }

  clear(): void {
    this.held = [];
    this.blocks = [];
    this.focusStart = this.state === 'focused' ? this.now() : null;
    this.options.onChange?.();
  }

  private allBlocks(): Block[] {
    return this.focusStart === null ? this.blocks : [...this.blocks, { start: this.focusStart, end: this.now() }];
  }

  private minutesSince(from: number): { minutes: number; blocks: number; longest: number } {
    let total = 0;
    let longest = 0;
    let count = 0;
    for (const block of this.allBlocks()) {
      const ms = block.end - Math.max(block.start, from);
      if (ms <= 0) continue;
      total += ms;
      longest = Math.max(longest, ms);
      count += 1;
    }
    return { minutes: Math.round(total / 60_000), blocks: count, longest: Math.round(longest / 60_000) };
  }

  async getDevState(): Promise<DevStateView> {
    return {
      state: this.state,
      since: new Date(this.since).toISOString(),
      focusMinutesToday: this.minutesSince(this.startOfDay(this.now())).minutes,
      heldMessages: this.held.length,
    };
  }

  /** The reason is accepted for the agent's benefit. It is not stored. */
  async shouldInterrupt(priority: Priority): Promise<InterruptAnswer> {
    switch (this.state) {
      case 'focused':
      case 'talking':
        if (priority === 'urgent') return { allow: true, advice: 'Urgent only. Keep it short.' };
        return {
          allow: false,
          retryAfterSeconds: 600,
          advice: `The user is ${this.state === 'focused' ? 'focusing' : 'in a conversation'}. Call queue_message and keep working.`,
        };
      case 'away':
        return { allow: false, retryAfterSeconds: 600, advice: 'The user is away. Call queue_message and keep working.' };
      default:
        return { allow: true, advice: 'Go ahead.' };
    }
  }

  async queueMessage(text: string, priority: Priority, source: string): Promise<QueueAnswer> {
    const clean = text.trim().slice(0, MAX_TEXT);
    if (!clean) return { queued: false, heldMessages: this.held.length, advice: 'The message is empty.' };
    if (this.held.length >= MAX_HELD) return { queued: false, heldMessages: this.held.length, advice: 'The queue is full. Keep working and summarize later.' };
    this.held = [...this.held, { text: clean, priority, source: source.trim().slice(0, MAX_FIELD) || 'agent', ts: this.now() }];
    this.options.onChange?.();
    // Nothing to wait for if the user is already free.
    if (isOpen(this.state)) {
      const count = this.held.length;
      this.deliver();
      return { queued: true, heldMessages: 0, advice: `Delivered ${count} now, since the user is available.` };
    }
    return { queued: true, heldMessages: this.held.length, advice: 'Held. It will be delivered when the user is available.' };
  }

  async waitUntilAvailable(timeoutSeconds: number): Promise<WaitAnswer> {
    if (isOpen(this.state)) return { available: true, state: this.state };
    const ms = Math.min(Math.max(timeoutSeconds, 0), MAX_WAIT_SECONDS) * 1000;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
    return { available: isOpen(this.state), state: this.state };
  }

  async getFocusSummary(range: SummaryRange): Promise<FocusSummary> {
    const from = range === '7d' ? this.startOfDay(this.now()) - 6 * DAY_MS : this.startOfDay(this.now());
    const { minutes, blocks, longest } = this.minutesSince(from);
    return { range, focusMinutes: minutes, blocks, longestBlockMinutes: longest };
  }
}
