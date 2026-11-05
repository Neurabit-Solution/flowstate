// JSONL format for recorded metrics (never video), and a replay source with the same
// interface as live. Pure TypeScript with no Electron or fs, so tests and the renderer share it.
import type { RecordingHeader, SignalEvent, SignalListener, SignalSource } from './types';

export const SAMPLE_LABEL = 'Sample recording (not live)';

export type Recording = { header: RecordingHeader; events: SignalEvent[] };

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const arr = (v: unknown): v is unknown[] => Array.isArray(v);
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/**
 * Rebuilds an event from known fields only, and returns null for anything else. The recorder
 * runs this too, so an unexpected field cannot end up on disk.
 */
export function sanitizeEvent(input: unknown): SignalEvent | null {
  if (!obj(input) || !num(input.ts)) return null;
  const ts = input.ts;
  switch (input.t) {
    case 'metrics': {
      const { upperTrace, rate, talking } = input;
      if (!arr(upperTrace) || !arr(rate) || !arr(talking)) return null;
      return {
        t: 'metrics',
        ts,
        upperTrace: upperTrace.filter(obj).map((s) => ({ ts: Number(s.ts), value: Number(s.value), stable: !!s.stable })),
        rate: rate.filter(obj).map((s) => ({
          ts: Number(s.ts),
          value: Number(s.value),
          stable: !!s.stable,
          confidence: Number(s.confidence),
        })),
        talking: talking.filter(obj).map((s) => ({ ts: Number(s.ts), detected: !!s.detected, stable: !!s.stable })),
      };
    }
    case 'validation':
      return num(input.code) ? { t: 'validation', ts, code: input.code, hint: String(input.hint ?? '') } : null;
    case 'processing':
      return num(input.status) ? { t: 'processing', ts, status: input.status } : null;
    case 'error':
      return num(input.code)
        ? { t: 'error', ts, code: input.code, message: String(input.message ?? ''), retryable: !!input.retryable }
        : null;
    default:
      return null;
  }
}

export function serializeHeader(header: RecordingHeader): string {
  return JSON.stringify(header);
}

export function parseRecording(text: string): Recording {
  const lines = text.split('\n').filter((line) => line.trim().length > 0);
  const first = lines[0];
  if (first === undefined) throw new Error('Recording is empty');
  const header = JSON.parse(first) as RecordingHeader;
  if (header.t !== 'header' || header.version !== 1) throw new Error('Recording has no valid header');
  const events: SignalEvent[] = [];
  lines.slice(1).forEach((line, i) => {
    const event = sanitizeEvent(JSON.parse(line));
    if (!event) throw new Error(`Invalid event on line ${i + 2}`);
    events.push(event);
  });
  return { header, events };
}

export type ReplayOptions = {
  /** Time multiplier. Infinity emits everything without waiting, which is what tests use. */
  speed?: number;
  onEnd?: () => void;
};

export class ReplaySource implements SignalSource {
  readonly kind = 'replay' as const;
  readonly label = SAMPLE_LABEL;

  private listeners = new Set<SignalListener>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly recording: Recording,
    private readonly options: ReplayOptions = {},
  ) {}

  subscribe(listener: SignalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const speed = this.options.speed ?? 1;
    if (speed === Infinity) {
      for (const event of this.recording.events) this.emit(event);
      this.finish();
      return;
    }
    this.scheduleFrom(0, speed);
  }

  async stop(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.running = false;
  }

  private scheduleFrom(index: number, speed: number): void {
    const event = this.recording.events[index];
    if (!this.running) return;
    if (!event) {
      this.finish();
      return;
    }
    const prev = this.recording.events[index - 1];
    // Timestamps are microseconds.
    const delayMs = prev ? Math.max(0, event.ts - prev.ts) / 1000 / speed : 0;
    this.timer = setTimeout(() => {
      this.emit(event);
      this.scheduleFrom(index + 1, speed);
    }, delayMs);
  }

  private finish(): void {
    this.running = false;
    this.options.onEnd?.();
  }

  private emit(event: SignalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
