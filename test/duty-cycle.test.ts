import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DutyCycle, type DutyTarget } from '../src/signals/duty-cycle';

const MIN = 60_000;
const config = { sampleMs: MIN, everyMs: 5 * MIN, maxHoldMs: 5 * MIN, checkMs: 5000 };

function setup() {
  const log: string[] = [];
  const target: DutyTarget = {
    start: async () => void log.push('start'),
    stop: async () => void log.push('stop'),
  };
  let sdkMs = 0;
  const cycle = new DutyCycle(target, config, { onSdkMs: (ms) => (sdkMs += ms) });
  return { cycle, log, sdk: () => sdkMs };
}

describe('duty cycle', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('samples 60 s every 5 min and counts only the time the SDK ran', async () => {
    const { cycle, log, sdk } = setup();
    await cycle.start();
    await vi.advanceTimersByTimeAsync(10 * MIN + 1000);
    expect(log).toEqual(['start', 'stop', 'start', 'stop', 'start']);
    expect(sdk()).toBe(2 * MIN);
    await cycle.stop();
    expect(log.at(-1)).toBe('stop');
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(log.filter((l) => l === 'start').length).toBe(3);
  });

  it('stays on while holding, but no longer than the limit', async () => {
    const { cycle, log, sdk } = setup();
    await cycle.start();
    cycle.setHold(true);
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(log).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(log).toEqual(['start', 'stop']);
    expect(sdk()).toBeLessThanOrEqual(6 * MIN + config.checkMs);
    await cycle.stop();
  });

  it('a hold during the off period starts a sample early', async () => {
    const { cycle, log } = setup();
    await cycle.start();
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(log).toEqual(['start', 'stop']);
    cycle.setHold(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(['start', 'stop', 'start']);
    await cycle.stop();
  });

  it('a retryable SDK error ends the sample and tries again next cycle', async () => {
    const { cycle, log } = setup();
    await cycle.start();
    await vi.advanceTimersByTimeAsync(10_000);
    await cycle.onRetryableError();
    expect(log).toEqual(['start', 'stop']);
    await vi.advanceTimersByTimeAsync(4 * MIN + 1000);
    expect(log).toEqual(['start', 'stop', 'start']);
    await cycle.stop();
  });

  it('a failed start stops the cycle and reports it', async () => {
    const onFatal = vi.fn();
    const target: DutyTarget = { start: async () => Promise.reject(new Error('bad key')), stop: async () => undefined };
    const cycle = new DutyCycle(target, config, { onFatal });
    await cycle.start();
    expect(onFatal).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(onFatal).toHaveBeenCalledOnce();
  });
});
