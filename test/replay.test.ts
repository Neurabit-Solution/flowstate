import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlRecorder } from '../src/signals/recorder';
import { parseRecording, ReplaySource, sanitizeEvent } from '../src/signals/replay';
import type { MetricsEvent, SignalEvent, SignalSource } from '../src/signals/types';

const smoke = () => parseRecording(readFileSync('recordings/synthetic-talking-interruption.jsonl', 'utf8'));

async function collect(source: SignalSource): Promise<SignalEvent[]> {
  const events: SignalEvent[] = [];
  source.subscribe((e) => events.push(e));
  await source.start();
  return events;
}

describe('replay', () => {
  afterEach(() => vi.useRealTimers());

  it('replays a recording through the SignalSource interface', async () => {
    const recording = smoke();
    expect(recording.header.origin).toBe('synthetic');
    const source = new ReplaySource(recording, { speed: Infinity });
    expect(source.label).toBe('Sample recording (not live)');

    const events = await collect(source);
    expect(events).toEqual(recording.events);

    const metrics = events.filter((e): e is MetricsEvent => e.t === 'metrics');
    expect(metrics.length).toBe(20 * 60);
    expect(metrics.flatMap((m) => m.talking).filter((t) => t.detected).length).toBeGreaterThan(30);
  });

  it('keeps the recorded timing, and stop halts it', async () => {
    vi.useFakeTimers();
    const source = new ReplaySource(smoke(), { speed: 1 });
    const events = await collect(source);
    await vi.advanceTimersByTimeAsync(5_000);
    const firstMetric = events.filter((e) => e.t === 'metrics').length;
    expect(firstMetric).toBeGreaterThanOrEqual(4);
    expect(firstMetric).toBeLessThanOrEqual(5);

    await source.stop();
    const count = events.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(events.length).toBe(count);
  });

  it('rejects a file with no header', () => {
    expect(() => parseRecording('{"t":"metrics","ts":1}\n')).toThrow(/header/);
    expect(() => parseRecording('')).toThrow(/empty/);
  });
});

describe('recorder', () => {
  it('round-trips through replay and strips anything that is not a known field', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flowstate-'));
    try {
      const recorder = new JsonlRecorder(dir, { origin: 'live', startedAt: '2026-11-06T00:00:00.000Z', sdkVersion: '3.4.0' });
      const event = {
        t: 'metrics',
        ts: 5,
        upperTrace: [{ ts: 1, value: 0.5, stable: true, frame: 'pixels' }],
        rate: [],
        talking: [{ ts: 1, detected: true, stable: false }],
        landmarks: [[1, 2]],
        frame: 'pixels',
      };
      expect(recorder.append(event)).toBe(true);
      expect(recorder.append({ t: 'frame', ts: 1, data: 'pixels' })).toBe(false);
      recorder.close();

      const text = readFileSync(recorder.path, 'utf8');
      expect(text).not.toContain('pixels');
      expect(text).not.toContain('landmarks');
      const { header, events } = parseRecording(text);
      expect(header.origin).toBe('live');
      expect(events).toEqual([sanitizeEvent(event)]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
