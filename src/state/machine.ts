// features -> DevState, per docs/SPEC.md section 3. Pure: time comes in with each call, so
// replay and tests run the same logic as live. Only reads yes/no features.
import type { DevState, DevStatus, Features, Override } from '../shared/types';

export type MachineConfig = {
  focusEnterMs: number;
  /** Contrary signal needed to leave focus, or to drop a focus candidate. */
  focusExitMs: number;
  awayAfterMs: number;
  /** Talking this long ends focus. */
  talkExitMs: number;
  /** Keep the SDK running when focus is this close, or when leaving it is in question. */
  confirmWindowMs: number;
};

export const DEFAULT_MACHINE_CONFIG: MachineConfig = {
  focusEnterMs: 10 * 60_000,
  focusExitMs: 2 * 60_000,
  awayAfterMs: 60_000,
  talkExitMs: 60_000,
  confirmWindowMs: 5 * 60_000,
};

export class DevStateMachine {
  private auto: DevState = 'off';
  private since = 0;
  private override: Override | null = null;
  private overrideUntil: number | null = null;
  private absentSince: number | null = null;
  private talkingSince: number | null = null;
  private steadySince: number | null = null;
  private contrarySince: number | null = null;
  private lastTs = 0;

  constructor(private config: MachineConfig = DEFAULT_MACHINE_CONFIG) {}

  setConfig(config: MachineConfig): void {
    this.config = config;
  }

  status(): DevStatus {
    const state: DevState =
      this.override === 'focus' ? 'focused' : this.override === 'free' ? 'available' : this.override === 'paused' ? 'off' : this.auto;
    return { state, since: this.since, override: this.override };
  }

  /** The user turned sensing on or a source began. */
  start(ts: number): DevStatus {
    this.clearTimers();
    this.transition('warming_up', ts);
    return this.status();
  }

  /** The user turned sensing off. */
  stop(ts: number): DevStatus {
    this.clearTimers();
    this.transition('off', ts);
    return this.status();
  }

  /** Manual choice always wins. null returns to automatic. */
  setOverride(override: Override | null, ts: number, untilTs: number | null = null): DevStatus {
    this.override = override;
    this.overrideUntil = untilTs;
    this.since = ts;
    this.clearTimers();
    return this.status();
  }

  /** Screen locked: nobody is at the keyboard, so skip the away delay. */
  markAway(ts: number): DevStatus {
    if (this.auto !== 'off') {
      this.clearTimers();
      this.absentSince = ts;
      this.transition('away', ts);
    }
    return this.status();
  }

  /** True while it is worth keeping the SDK running to confirm a change around focus. */
  get confirming(): boolean {
    if (this.override || this.auto === 'off') return false;
    if (this.auto === 'focused') return this.contrarySince !== null;
    if (this.steadySince === null) return false;
    return this.lastTs - this.steadySince >= this.config.focusEnterMs - this.config.confirmWindowMs;
  }

  update(f: Features): DevStatus {
    const ts = f.ts;
    this.lastTs = ts;
    if (this.override && this.overrideUntil !== null && ts >= this.overrideUntil) {
      this.override = null;
      this.overrideUntil = null;
      this.since = ts;
    }
    if (this.override || this.auto === 'off') return this.status();

    this.track(f);
    const next = this.decide(f, ts);
    if (next !== this.auto) this.transition(next, ts);
    return this.status();
  }

  private track(f: Features): void {
    const { ts } = f;
    if (f.present === false) this.absentSince ??= ts;
    else if (f.present === true) this.absentSince = null;

    if (f.talking === true && f.present !== false) this.talkingSince ??= ts;
    else if (f.talking === false || f.present === false) this.talkingSince = null;

    if (f.steady === true && f.talking !== true && f.present !== false) {
      this.steadySince ??= ts;
      this.contrarySince = null;
    } else if (f.steady === false) {
      this.contrarySince ??= ts;
    }

    // Talking ends a focus candidate at once. A brief dip in steadiness does not.
    if (f.talking === true) this.steadySince = null;
    if (this.contrarySince !== null && ts - this.contrarySince >= this.config.focusExitMs) this.steadySince = null;
    if (this.absentSince !== null && ts - this.absentSince >= this.config.awayAfterMs) this.steadySince = null;
  }

  private decide(f: Features, ts: number): DevState {
    const { awayAfterMs, focusEnterMs, focusExitMs, talkExitMs } = this.config;
    if (this.absentSince !== null && ts - this.absentSince >= awayAfterMs) return 'away';

    if (this.auto === 'focused') {
      if (this.talkingSince !== null && ts - this.talkingSince >= talkExitMs) return 'talking';
      if (this.contrarySince !== null && ts - this.contrarySince >= focusExitMs) return 'available';
      return 'focused';
    }

    if (this.talkingSince !== null) return 'talking';
    if (this.steadySince !== null && ts - this.steadySince >= focusEnterMs) return 'focused';

    // With no reading, carry the current state forward.
    if (this.absentSince === null && f.present === true) return 'available';
    if (this.auto === 'talking' && f.talking === false) return 'available';
    return this.auto;
  }

  private transition(state: DevState, ts: number): void {
    if (state === this.auto) return;
    this.auto = state;
    if (!this.override) this.since = ts;
    if (state === 'focused') this.contrarySince = null;
  }

  private clearTimers(): void {
    this.absentSince = null;
    this.talkingSince = null;
    this.steadySince = null;
    this.contrarySince = null;
  }
}
