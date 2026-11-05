import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { DevState, Features } from '../src/shared/types';
import { SignalProcessor } from '../src/signals/processor';
import { parseRecording } from '../src/signals/replay';
import { DEFAULT_MACHINE_CONFIG, DevStateMachine } from '../src/state/machine';

const MIN = 60_000;

/** Runs a recording through processor + machine, like the app does. */
function run(name: string) {
  const { events } = parseRecording(readFileSync(`recordings/synthetic-${name}.jsonl`, 'utf8'));
  const processor = new SignalProcessor();
  const machine = new DevStateMachine();
  const start = Math.round(events[0]!.ts / 1000);
  machine.start(start);
  const path: { state: DevState; atMin: number }[] = [{ state: 'warming_up', atMin: 0 }];
  let last: DevState | null = 'warming_up';
  for (const event of events) {
    const features = processor.ingest(event);
    if (!features) continue;
    const { state } = machine.update(features);
    if (state !== last) path.push({ state, atMin: (features.ts - start) / MIN });
    last = state;
  }
  return path;
}

const states = (path: { state: DevState }[]) => path.map((p) => p.state);
const at = (path: { state: DevState; atMin: number }[], s: DevState) => path.find((p) => p.state === s)?.atMin ?? NaN;

describe('recordings through processor and state machine', () => {
  it('a long steady stretch reaches focus and stays', () => {
    const path = run('focus-block');
    expect(states(path)).toEqual(['warming_up', 'available', 'focused']);
    // Steady from minute 4, baseline in place, plus the 10 minute threshold.
    expect(at(path, 'focused')).toBeGreaterThan(10);
    expect(at(path, 'focused')).toBeLessThan(17);
  });

  it('a conversation breaks focus after about a minute', () => {
    const path = run('talking-interruption');
    const seq = states(path);
    expect(seq.slice(0, 4)).toEqual(['warming_up', 'available', 'focused', 'talking']);
    expect(at(path, 'talking')).toBeGreaterThan(16);
    expect(at(path, 'talking')).toBeLessThan(17.5);
    expect(seq.at(-1)).toBe('available');
  });

  it('leaving the desk goes to away, and returning goes to available', () => {
    const path = run('away');
    const seq = states(path);
    expect(seq).toEqual(['warming_up', 'available', 'focused', 'away', 'available']);
    expect(at(path, 'away')).toBeGreaterThan(17);
    expect(at(path, 'away')).toBeLessThan(17.5);
  });
});

describe('state machine rules', () => {
  const f = (ts: number, over: Partial<Features> = {}): Features => ({ ts, present: true, talking: false, steady: true, ...over });
  const focused = () => {
    const m = new DevStateMachine();
    m.start(0);
    m.update(f(0));
    m.update(f(DEFAULT_MACHINE_CONFIG.focusEnterMs));
    expect(m.status().state).toBe('focused');
    return m;
  };
  const T = DEFAULT_MACHINE_CONFIG.focusEnterMs;

  it('is off until started, and ignores features while off', () => {
    const m = new DevStateMachine();
    expect(m.update(f(1000)).state).toBe('off');
  });

  it('needs the full threshold to enter focus', () => {
    const m = new DevStateMachine();
    m.start(0);
    m.update(f(0));
    expect(m.update(f(T - 1)).state).toBe('available');
    expect(m.update(f(T)).state).toBe('focused');
  });

  it('a short dip in steadiness does not leave focus, two minutes does', () => {
    const m = focused();
    expect(m.update(f(T + MIN, { steady: false })).state).toBe('focused');
    expect(m.update(f(T + 2 * MIN, { steady: true })).state).toBe('focused');
    m.update(f(T + 3 * MIN, { steady: false }));
    expect(m.update(f(T + 5 * MIN, { steady: false })).state).toBe('available');
  });

  it('carries the state forward when there is no reading', () => {
    const m = focused();
    const none = { present: null, talking: null, steady: null };
    expect(m.update(f(T + 4 * MIN, none)).state).toBe('focused');
  });

  it('a missed sample does not reset the time counted toward focus', () => {
    const m = new DevStateMachine();
    m.start(0);
    m.update(f(0));
    m.update(f(5 * MIN, { present: null, talking: null, steady: null }));
    expect(m.update(f(T)).state).toBe('focused');
  });

  it('away takes 60 s, and the heartbeat with no reading still counts it', () => {
    const m = focused();
    m.update(f(T + 1000, { present: false, talking: null, steady: null }));
    const none = { present: null, talking: null, steady: null };
    expect(m.update(f(T + 30_000, none)).state).toBe('focused');
    expect(m.update(f(T + 61_000, none)).state).toBe('away');
  });

  it('manual choices win, expire, and return to automatic', () => {
    const m = focused();
    m.setOverride('free', T);
    expect(m.update(f(T + 1000)).state).toBe('available');
    m.setOverride('paused', T + 2000, T + 3000);
    expect(m.status().state).toBe('off');
    expect(m.update(f(T + 2500)).state).toBe('off');
    expect(m.update(f(T + 3000)).override).toBeNull();
    m.setOverride('focus', T + 4000);
    expect(m.update(f(T + 5000, { present: false })).state).toBe('focused');
  });

  it('confirming turns on near the threshold and when leaving focus is in question', () => {
    const m = new DevStateMachine();
    m.start(0);
    m.update(f(0));
    m.update(f(MIN));
    expect(m.confirming).toBe(false);
    m.update(f(T - 4 * MIN));
    expect(m.confirming).toBe(true);
    const leaving = focused();
    expect(leaving.confirming).toBe(false);
    leaving.update(f(T + 1000, { steady: false }));
    expect(leaving.confirming).toBe(true);
  });

  it('a screen lock goes to away at once', () => {
    const m = focused();
    expect(m.markAway(T + 1).state).toBe('away');
  });
});
