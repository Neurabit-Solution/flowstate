// Runs the SDK in short samples to protect credits. Default: 60 s every 5 min, staying on
// (up to 5 min) while a change around focus is being confirmed.

export type DutyConfig = { sampleMs: number; everyMs: number; maxHoldMs: number; checkMs: number };

export type DutyTarget = { start(): Promise<void>; stop(): Promise<void> };

export type DutyCallbacks = {
  /** Time the SDK actually ran, for the "SDK minutes today" counter. */
  onSdkMs?: (ms: number) => void;
  onRunning?: (running: boolean) => void;
  onFatal?: (err: unknown) => void;
  now?: () => number;
};

export class DutyCycle {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private running = false;
  private hold = false;
  private runStartedAt = 0;
  private holdStartedAt: number | null = null;
  private readonly now: () => number;

  constructor(
    private readonly target: DutyTarget,
    private config: DutyConfig,
    private readonly callbacks: DutyCallbacks = {},
  ) {
    this.now = callbacks.now ?? Date.now;
  }

  setConfig(config: DutyConfig): void {
    this.config = config;
  }

  async start(firstSampleMs?: number): Promise<void> {
    if (this.active) return;
    this.active = true;
    await this.run(firstSampleMs ?? this.config.sampleMs);
  }

  async stop(): Promise<void> {
    this.active = false;
    this.clear();
    await this.endRun();
  }

  /** Asks to stay on, or to start a sample early, to confirm a change around focus. */
  setHold(hold: boolean): void {
    this.hold = hold;
    if (!hold) this.holdStartedAt = null;
    if (hold && this.active && !this.running) {
      this.clear();
      void this.run(this.config.sampleMs);
    }
  }

  /** The SDK reported a problem it can retry, such as an empty frame. Try again next cycle. */
  async onRetryableError(): Promise<void> {
    if (!this.active) return;
    this.clear();
    await this.endRun();
    this.schedule(this.config.everyMs - this.config.sampleMs);
  }

  private async run(sampleMs: number): Promise<void> {
    if (!this.active || this.running) return;
    this.running = true;
    this.runStartedAt = this.now();
    this.callbacks.onRunning?.(true);
    try {
      await this.target.start();
    } catch (err) {
      await this.stop();
      this.callbacks.onFatal?.(err);
      return;
    }
    this.timer = setTimeout(() => void this.sampleEnded(), sampleMs);
  }

  private async sampleEnded(): Promise<void> {
    if (!this.active) return;
    if (this.hold) {
      this.holdStartedAt ??= this.now();
      if (this.now() - this.holdStartedAt < this.config.maxHoldMs) {
        this.timer = setTimeout(() => void this.sampleEnded(), this.config.checkMs);
        return;
      }
    }
    await this.endRun();
    this.schedule(this.config.everyMs - this.config.sampleMs);
  }

  private schedule(ms: number): void {
    if (!this.active) return;
    this.timer = setTimeout(() => void this.run(this.config.sampleMs), Math.max(0, ms));
  }

  private async endRun(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.callbacks.onSdkMs?.(this.now() - this.runStartedAt);
    this.callbacks.onRunning?.(false);
    try {
      await this.target.stop();
    } catch {
      // Nothing more to do. The source releases the camera in its own teardown.
    }
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
