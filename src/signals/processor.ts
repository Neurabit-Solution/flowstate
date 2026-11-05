// Raw metrics -> yes/no features. Raw values go no further than this file and the debug panel.
import type { Features } from '../shared/types';
import type { SignalEvent, TraceSample } from './types';

const SECOND_US = 1_000_000;
const PRESENCE_WINDOW_US = 20 * SECOND_US;
const TALKING_WINDOW_US = 20 * SECOND_US;
const TRACE_WINDOW_US = 120 * SECOND_US;
const MIN_OBSERVED_US = 3 * SECOND_US;
const MIN_TALKING_SAMPLES = 3;
const PRESENT_FRACTION = 0.8;
const TALKING_FRACTION = 0.3;
const SCORE_EVERY_US = 30 * SECOND_US;
const EMIT_EVERY_US = SECOND_US;
const MAX_TRACE_GAP_US = 2 * SECOND_US;
const BASELINE_MEMORY = 240;
const BASELINE_TOLERANCE = 0.02;

const NO_FACE = 1;
const RUNNING = 3;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function coefficientOfVariation(xs: number[]): number {
  const m = mean(xs);
  if (m === 0) return 1;
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))) / Math.abs(m);
}

export function median(xs: number[]): number {
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const hi = sorted[mid] ?? 0;
  return sorted.length % 2 ? hi : (hi + (sorted[mid - 1] ?? hi)) / 2;
}

/**
 * Regularity of breath timing and depth, 0..1. Returns null with too little to judge.
 * Only ever compared with this person's own history, never with a fixed "good" value.
 */
export function regularityScore(samples: TraceSample[]): number | null {
  const intervals: number[] = [];
  const depths: number[] = [];
  let segment: TraceSample[] = [];
  const flush = () => {
    if (segment.length >= 8) collectBreaths(segment, intervals, depths);
    segment = [];
  };
  for (const s of samples) {
    const prev = segment[segment.length - 1];
    if (prev && s.ts - prev.ts > MAX_TRACE_GAP_US) flush();
    segment.push(s);
  }
  flush();
  if (intervals.length < 4 || depths.length < 4) return null;
  return clamp01(0.6 * (1 - coefficientOfVariation(intervals)) + 0.4 * (1 - coefficientOfVariation(depths)));
}

function collectBreaths(segment: TraceSample[], intervals: number[], depths: number[]): void {
  const center = mean(segment.map((s) => s.value));
  const values = segment.map((s) => s.value - center);
  const band = 0.25 * Math.sqrt(mean(values.map((v) => v * v)));
  let armed = false;
  let lastCrossing: number | null = null;
  let lo = Infinity;
  let hi = -Infinity;
  values.forEach((v, i) => {
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    if (v < -band) armed = true;
    if (armed && v > band) {
      armed = false;
      const ts = segment[i]?.ts ?? 0;
      if (lastCrossing !== null) {
        intervals.push(ts - lastCrossing);
        depths.push(hi - lo);
      }
      lastCrossing = ts;
      lo = Infinity;
      hi = -Infinity;
    }
  });
}

export class SignalProcessor {
  private latestTs = 0;
  private lastEmit = 0;
  private lastScoreAt = 0;

  private observing = false;
  private faceOk = false;
  private segmentStart = 0;
  private segments: { start: number; end: number; ok: boolean }[] = [];

  private talkingSamples: { ts: number; detected: boolean }[] = [];
  private trace: TraceSample[] = [];
  private scores: number[] = [];
  private steady: boolean | null = null;

  /** Demo mode scores more often so the baseline fills in seconds, not minutes. */
  constructor(private readonly scoreEveryUs: number = SCORE_EVERY_US) {}

  /** True once there is enough history to compare against. */
  get baselineReady(): boolean {
    return this.scores.length >= 4;
  }

  /** Returns features at most once per second of signal time. */
  ingest(event: SignalEvent): Features | null {
    this.latestTs = Math.max(this.latestTs, event.ts);
    switch (event.t) {
      case 'processing':
        if (event.status === RUNNING) this.openSegment(event.ts);
        else this.closeSegment(event.ts);
        break;
      case 'validation':
        this.onValidation(event.code, event.ts);
        break;
      case 'metrics':
        for (const t of event.talking) this.talkingSamples.push({ ts: t.ts, detected: t.detected });
        this.addTrace(event.upperTrace);
        break;
      case 'error':
        break;
    }
    if (this.latestTs - this.lastScoreAt >= this.scoreEveryUs) this.score();
    if (this.latestTs - this.lastEmit < EMIT_EVERY_US) return null;
    this.lastEmit = this.latestTs;
    return this.features();
  }

  private onValidation(code: number, ts: number): void {
    // Only "no face" counts as absent. Bad lighting or a poor angle means someone is still there.
    const ok = code !== NO_FACE;
    if (!this.observing) this.openSegment(ts);
    if (ok !== this.faceOk) {
      this.closeSegment(ts);
      this.observing = true;
      this.segmentStart = ts;
      this.faceOk = ok;
    }
  }

  private openSegment(ts: number): void {
    if (this.observing) return;
    this.observing = true;
    this.segmentStart = ts;
  }

  private closeSegment(ts: number): void {
    if (!this.observing) return;
    this.segments.push({ start: this.segmentStart, end: ts, ok: this.faceOk });
    this.observing = false;
  }

  private addTrace(samples: TraceSample[]): void {
    for (const s of samples) {
      const last = this.trace[this.trace.length - 1];
      // Slices can repeat a sample. Unstable samples are not worth judging.
      if (s.stable && (!last || s.ts > last.ts)) this.trace.push(s);
    }
  }

  private score(): void {
    this.lastScoreAt = this.latestTs;
    const cutoff = this.latestTs - TRACE_WINDOW_US;
    this.trace = this.trace.filter((s) => s.ts >= cutoff);
    const score = regularityScore(this.trace);
    if (score === null) {
      this.steady = null;
      return;
    }
    this.steady = this.baselineReady ? score >= median(this.scores) - BASELINE_TOLERANCE : null;
    this.scores.push(score);
    if (this.scores.length > BASELINE_MEMORY) this.scores.shift();
  }

  private features(): Features {
    const now = this.latestTs;
    return { ts: Math.round(now / 1000), present: this.present(now), talking: this.talking(now), steady: this.steady };
  }

  private present(now: number): boolean | null {
    const from = now - PRESENCE_WINDOW_US;
    this.segments = this.segments.filter((s) => s.end >= from);
    const all = this.observing ? [...this.segments, { start: this.segmentStart, end: now, ok: this.faceOk }] : this.segments;
    let observed = 0;
    let ok = 0;
    for (const s of all) {
      const span = s.end - Math.max(s.start, from);
      if (span <= 0) continue;
      observed += span;
      if (s.ok) ok += span;
    }
    return observed < MIN_OBSERVED_US ? null : ok / observed >= PRESENT_FRACTION;
  }

  private talking(now: number): boolean | null {
    const from = now - TALKING_WINDOW_US;
    this.talkingSamples = this.talkingSamples.filter((s) => s.ts >= from);
    if (this.talkingSamples.length < MIN_TALKING_SAMPLES) return null;
    const talking = this.talkingSamples.filter((s) => s.detected).length;
    return talking / this.talkingSamples.length >= TALKING_FRACTION;
  }
}
