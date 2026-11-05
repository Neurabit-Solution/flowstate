import { Metrics } from '@smartspectra/node-sdk/messages';
import { MetricType, ProcessingStatus, ValidationCode } from '@smartspectra/node-sdk/renderer';
import { describe, expect, it } from 'vitest';
import { normalizeMetrics, type RawMetrics } from '../src/signals/normalize';
import { PROCESSING_NAMES, VALIDATION_NAMES } from '../src/signals/types';

describe('normalizeMetrics against the real SDK protobuf class', () => {
  it('reads the confirmed field names and drops everything else', () => {
    const message = Metrics.fromObject({
      breathing: {
        upperTrace: [{ value: 0.25, stable: true, timestamp: 1_800_000_000_000_001 }],
        rate: [{ value: 13, stable: true, confidence: 80, timestamp: 1_800_000_000_000_002 }],
      },
      face: {
        talking: [{ detected: true, stable: true, timestamp: 1_800_000_000_000_003 }],
        blinking: [{ detected: true, stable: true, timestamp: 1 }],
      },
      cardio: { pulseRate: [{ value: 70, stable: true, confidence: 90, timestamp: 1 }] },
    });
    const decoded = Metrics.decode(Metrics.encode(message).finish()) as unknown as RawMetrics;

    const event = normalizeMetrics(decoded, 42);

    expect(event).toEqual({
      t: 'metrics',
      ts: 42,
      upperTrace: [{ ts: 1_800_000_000_000_001, value: 0.25, stable: true }],
      rate: [{ ts: 1_800_000_000_000_002, value: 13, stable: true, confidence: 80 }],
      talking: [{ ts: 1_800_000_000_000_003, detected: true, stable: true }],
    });
    expect(JSON.stringify(event)).not.toContain('pulse');
    expect(JSON.stringify(event)).not.toContain('blinking');
  });

  it('copes with an empty slice', () => {
    expect(normalizeMetrics({}, 1)).toEqual({ t: 'metrics', ts: 1, upperTrace: [], rate: [], talking: [] });
  });
});

describe('SDK constants', () => {
  it('still match the local name tables', () => {
    expect(Object.keys(VALIDATION_NAMES).map(Number).sort((a, b) => a - b)).toEqual(
      Object.values(ValidationCode).map(Number).sort((a, b) => a - b),
    );
    expect(Object.keys(PROCESSING_NAMES).map(Number).sort((a, b) => a - b)).toEqual(
      Object.values(ProcessingStatus).map(Number).sort((a, b) => a - b),
    );
    expect(MetricType.TALKING).toBe(13);
  });
});
