// The live Presage SmartSpectra integration. This module and main/index.ts's
// bindSmartSpectraIpc call are the only places that touch the SDK.
import { decodeMetrics } from '@smartspectra/node-sdk/messages';
import { MetricType, SmartSpectraSDK } from '@smartspectra/node-sdk/renderer';
import { normalizeMetrics, type RawMetrics } from './normalize';
import type { SignalEvent, SignalListener, SignalSource } from './types';

/**
 * Only what FlowState uses. Not the SDK's `breathingMetrics` bundle, which also includes
 * values we have no use for, and no cardio metrics at all.
 */
export const REQUESTED_METRICS: number[] = [
  MetricType.CHEST_BREATHING,
  MetricType.BREATHING_RATE,
  MetricType.TALKING,
];

/** Credits guard. M1 replaces this with duty-cycled sampling. */
export const MAX_LIVE_SESSION_MS = 15 * 60 * 1000;

export type LiveOptions = {
  getApiKey: () => Promise<string | null>;
  /** The SDK defaults telemetry to on, so this is always passed explicitly. */
  enableTelemetry: () => boolean;
  onStream?: (stream: MediaStream | null) => void;
  /** Frames per second the camera is actually delivering, about once a second. */
  onFrameRate?: (fps: number) => void;
  /** Called when the session cap stops the camera by itself. */
  onAutoStop?: () => void;
};

export class LiveSource implements SignalSource {
  readonly kind = 'live' as const;
  readonly label = 'Live camera';

  private sdk: SmartSpectraSDK | null = null;
  private stream: MediaStream | null = null;
  private capTimer: ReturnType<typeof setTimeout> | null = null;
  private fpsTimer: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<SignalListener>();

  constructor(private readonly options: LiveOptions) {}

  subscribe(listener: SignalListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: SignalEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  /** Must only ever run from an explicit user click. */
  async start(): Promise<void> {
    if (this.sdk) return;
    const apiKey = await this.options.getApiKey();
    if (!apiKey) throw new Error('No Presage API key. Add PRESAGE_API_KEY to .env, or use the sample recording.');

    const sdk = new SmartSpectraSDK({
      apiKey,
      requestedMetrics: REQUESTED_METRICS,
      enableAccumulatedOutput: false,
      enableTelemetry: this.options.enableTelemetry(),
    });
    this.sdk = sdk;

    sdk.on('metrics', (buf, timestampUs) => {
      const decoded = decodeMetrics(buf as Buffer) as RawMetrics;
      this.emit(normalizeMetrics(decoded, timestampUs));
    });
    sdk.on('validationStatus', (code, timestampUs, hint) => {
      this.emit({ t: 'validation', ts: timestampUs, code, hint });
    });
    sdk.on('processingStatus', (status) => {
      this.emit({ t: 'processing', ts: Date.now() * 1000, status });
    });
    sdk.on('error', (code, message, retryable) => {
      this.emit({ t: 'error', ts: Date.now() * 1000, code, message, retryable });
    });
    sdk.on('streamAvailable', (stream) => {
      this.stream = stream;
      this.options.onStream?.(stream);
      this.watchFrameRate(stream);
    });

    try {
      await sdk.start();
    } catch (err) {
      this.teardown();
      throw err;
    }
    this.capTimer = setTimeout(() => {
      void this.stop().then(() => this.options.onAutoStop?.());
    }, MAX_LIVE_SESSION_MS);
  }

  async stop(): Promise<void> {
    const sdk = this.sdk;
    if (!sdk) return;
    await this.restoreAutoCamera();
    try {
      await sdk.stop();
    } finally {
      this.teardown();
    }
  }

  /** The SDK ends a session when frames arrive too slowly, without saying why in its error. */
  private watchFrameRate(stream: MediaStream): void {
    const track = stream.getVideoTracks()[0] as (MediaStreamTrack & { stats?: { deliveredFrames?: number } }) | undefined;
    if (!track?.stats) return;
    let last = track.stats.deliveredFrames ?? 0;
    this.fpsTimer = setInterval(() => {
      const now = track.stats?.deliveredFrames ?? last;
      this.options.onFrameRate?.(now - last);
      last = now;
    }, 1000);
  }

  private teardown(): void {
    if (this.fpsTimer) clearInterval(this.fpsTimer);
    this.fpsTimer = null;
    if (this.capTimer) clearTimeout(this.capTimer);
    this.capTimer = null;
    try {
      this.sdk?.destroy();
    } catch {
      // Already destroyed.
    }
    this.sdk = null;
    this.stream = null;
    this.options.onStream?.(null);
  }

  /**
   * The SDK locks exposure, white balance and focus while running. Some Linux drivers keep
   * that lock after stop, which makes the next session dark, so hand control back first.
   */
  private async restoreAutoCamera(): Promise<void> {
    const track = this.stream?.getVideoTracks()[0];
    if (!track || !navigator.userAgent.includes('Linux')) return;
    const caps = track.getCapabilities() as unknown as Record<string, unknown>;
    const advanced: Record<string, string>[] = [];
    for (const mode of ['exposureMode', 'whiteBalanceMode', 'focusMode']) {
      const supported = caps[mode];
      if (Array.isArray(supported) && supported.includes('continuous')) advanced.push({ [mode]: 'continuous' });
    }
    if (advanced.length === 0) return;
    try {
      await track.applyConstraints({ advanced } as MediaTrackConstraints);
    } catch {
      // Best effort. Not every driver accepts this.
    }
  }
}
