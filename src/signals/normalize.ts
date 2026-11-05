import type { MetricsEvent, RateSample, TalkingSample, TraceSample } from './types';

// Field names confirmed against the SDK's generated `Metrics` class (see test/normalize.test.ts).
// This is an allowlist on purpose: landmarks and anything else the SDK may add are dropped here,
// so they can never reach the recorder or the UI.

type Long = { toNumber(): number };
type RawTimestamp = number | bigint | Long | null | undefined;

type RawMeasurement = {
  value?: number | null;
  stable?: boolean | null;
  confidence?: number | null;
  timestamp?: RawTimestamp;
};
type RawDetection = { detected?: boolean | null; stable?: boolean | null; timestamp?: RawTimestamp };

export type RawMetrics = {
  breathing?: { upperTrace?: RawMeasurement[] | null; rate?: RawMeasurement[] | null } | null;
  face?: { talking?: RawDetection[] | null } | null;
};

/** Protobuf int64 fields decode to a Long object, not a number. */
export function toNumberTs(ts: RawTimestamp): number {
  if (ts == null) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts === 'bigint') return Number(ts);
  return ts.toNumber();
}

/** Each SDK `metrics` event is a windowed slice since the previous one, not a running total. */
export function normalizeMetrics(raw: RawMetrics, ts: number): MetricsEvent {
  const upperTrace: TraceSample[] = (raw.breathing?.upperTrace ?? []).map((m) => ({
    ts: toNumberTs(m.timestamp),
    value: m.value ?? 0,
    stable: !!m.stable,
  }));
  const rate: RateSample[] = (raw.breathing?.rate ?? []).map((m) => ({
    ts: toNumberTs(m.timestamp),
    value: m.value ?? 0,
    stable: !!m.stable,
    confidence: m.confidence ?? 0,
  }));
  const talking: TalkingSample[] = (raw.face?.talking ?? []).map((d) => ({
    ts: toNumberTs(d.timestamp),
    detected: !!d.detected,
    stable: !!d.stable,
  }));
  return { t: 'metrics', ts, upperTrace, rate, talking };
}
