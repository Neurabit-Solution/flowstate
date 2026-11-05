// Runs in the renderer. Owns the source, the processor and the recorder, and passes only
// yes/no features to the main process. Raw events go only to the debug panel inside signals/.
import type { FlowstateBridge, SensingSource, Settings } from '../shared/types';
import { DutyCycle, type DutyConfig } from './duty-cycle';
import { SignalProcessor } from './processor';
import { parseRecording, ReplaySource } from './replay';
import { LiveSource } from './sdk-session';
import type { SignalEvent, SignalListener, SignalSource } from './types';

const MAX_HOLD_MS = 5 * 60_000;
const DEMO_SCORE_EVERY_US = 5_000_000;
const AUTH_FAILED = 2;
/** Sample recordings run faster than real time, so a focus block takes under a minute. */
export const REPLAY_SPEED = 20;

export type HostMessage = { kind: 'error' | 'notice'; text: string };

export class SignalHost {
  private processor: SignalProcessor;
  private readonly live: LiveSource;
  private readonly duty: DutyCycle;
  private replay: ReplaySource | null = null;
  private replayUnsub: (() => void) | null = null;
  private source: SensingSource = null;
  private recordMetrics = false;
  private recording = false;
  private telemetry = false;
  private readonly listeners = new Set<SignalListener>();
  private readonly messageListeners = new Set<(m: HostMessage | null) => void>();
  private readonly streamListeners = new Set<(s: MediaStream | null) => void>();

  constructor(
    private readonly bridge: FlowstateBridge,
    private readonly demo: boolean,
  ) {
    this.processor = this.newProcessor();
    this.live = new LiveSource({
      getApiKey: () => bridge.getApiKey(),
      enableTelemetry: () => this.telemetry,
      onStream: (stream) => this.streamListeners.forEach((l) => l(stream)),
      onAutoStop: () => {
        this.message('notice', 'Camera stopped by the session limit.');
        void this.stopSensing();
      },
    });
    this.live.subscribe((event) => this.onEvent(event));
    this.duty = new DutyCycle(this.live, { sampleMs: 60_000, everyMs: 300_000, maxHoldMs: MAX_HOLD_MS, checkMs: 5000 }, {
      onSdkMs: (ms) => bridge.reportSdkMs(ms),
      onRunning: (running) => {
        if (this.source === 'live') bridge.reportSensing('live', running);
      },
      onFatal: (err) => {
        this.message('error', err instanceof Error ? err.message : String(err));
        void this.stopSensing();
      },
    });
    bridge.onCommand((command) => {
      if (command.type === 'start-sensing') void this.startSensing();
      if (command.type === 'stop-sensing') void this.stopSensing();
      if (command.type === 'set-hold') this.duty.setHold(command.hold);
    });
  }

  private newProcessor(): SignalProcessor {
    return this.demo ? new SignalProcessor(DEMO_SCORE_EVERY_US) : new SignalProcessor();
  }

  get activeSource(): SensingSource {
    return this.source;
  }

  subscribe(listener: SignalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onMessage(listener: (m: HostMessage | null) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onStream(listener: (s: MediaStream | null) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  setRecordMetrics(on: boolean): void {
    this.recordMetrics = on;
  }

  /**
   * Turns the camera on. Reached only from a click: a button in the app or the tray menu.
   * Nothing calls this at launch, and the choice is not remembered across launches.
   */
  async startSensing(firstSampleMs?: number): Promise<void> {
    if (this.source) return;
    this.clearMessage();
    const settings: Settings = await this.bridge.getSettings();
    this.telemetry = settings.telemetry;
    this.duty.setConfig(dutyConfig(settings));
    this.source = 'live';
    this.bridge.reportSensing('live', true);
    if (this.recordMetrics) {
      await this.bridge.recorderStart();
      this.recording = true;
    }
    await this.duty.start(firstSampleMs);
  }

  async stopSensing(): Promise<void> {
    if (this.source !== 'live') return;
    this.source = null;
    await this.duty.stop();
    await this.endRecording();
    this.bridge.reportSensing(null, false);
  }

  /** Feeds a recording through the same processor and state machine. Never touches the camera. */
  async startReplay(name: string): Promise<void> {
    if (this.source) return;
    this.clearMessage();
    const recording = parseRecording(await this.bridge.readRecording(name));
    this.source = 'replay';
    this.processor = this.newProcessor();
    this.bridge.reportSensing('replay', false);
    const source = new ReplaySource(recording, { speed: REPLAY_SPEED, onEnd: () => void this.endReplay() });
    this.replay = source;
    this.replayUnsub = (source as SignalSource).subscribe((event) => this.onEvent(event));
    if (recording.header.origin === 'synthetic') this.message('notice', 'This sample is generated test data, not a real session.');
    await source.start();
  }

  async stopReplay(): Promise<void> {
    await this.replay?.stop();
    await this.endReplay();
  }

  private async endReplay(): Promise<void> {
    if (this.source !== 'replay') return;
    this.replayUnsub?.();
    this.replayUnsub = null;
    this.replay = null;
    this.source = null;
    this.clearMessage();
    // A sample's baseline must not carry over into live sensing.
    this.processor = this.newProcessor();
    this.bridge.reportSensing(null, false);
  }

  private async endRecording(): Promise<void> {
    if (!this.recording) return;
    this.recording = false;
    await this.bridge.recorderStop();
  }

  private onEvent(event: SignalEvent): void {
    if (this.recording) this.bridge.recorderAppend(event);
    this.listeners.forEach((l) => l(event));
    const features = this.processor.ingest(event);
    if (features) this.bridge.sendFeatures(features);
    if (event.t === 'error' && this.source === 'live') {
      if (event.retryable) {
        void this.duty.onRetryableError();
      } else {
        this.message('error', event.code === AUTH_FAILED ? 'Presage rejected the API key. Replace it in Settings.' : `SDK error ${event.code}: ${event.message}`);
        void this.stopSensing();
      }
    }
  }

  private clearMessage(): void {
    this.messageListeners.forEach((l) => l(null));
  }

  private message(kind: HostMessage['kind'], text: string): void {
    this.messageListeners.forEach((l) => l({ kind, text }));
  }
}

function dutyConfig(s: Settings): DutyConfig {
  return { sampleMs: s.sampleSeconds * 1000, everyMs: s.everyMinutes * 60_000, maxHoldMs: MAX_HOLD_MS, checkMs: 5000 };
}
