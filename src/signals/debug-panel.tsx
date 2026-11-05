// "Live signal" debug panel. It lives in signals/ because it is the only UI allowed to see
// raw values. It draws the breathing trace and the talking flag, and shows no vitals numbers.
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseRecording, ReplaySource, SAMPLE_LABEL } from './replay';
import { LiveSource } from './sdk-session';
import { PROCESSING_NAMES, VALIDATION_NAMES, type SignalEvent, type SignalSource, type TraceSample } from './types';

const TRACE_WINDOW_US = 30_000_000;
const TALKING_FRESH_US = 3_000_000;
const PROCESSING_ERROR = 5;

export type SignalBridge = {
  getApiKey(): Promise<string | null>;
  hasApiKey(): Promise<boolean>;
  listRecordings(): Promise<string[]>;
  readRecording(name: string): Promise<string>;
  recorderStart(): Promise<string>;
  recorderAppend(event: SignalEvent): void;
  recorderStop(): Promise<void>;
};

type Mode = 'idle' | 'live' | 'replay';

function drawTrace(canvas: HTMLCanvasElement, samples: TraceSample[]): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  const last = samples[samples.length - 1];
  if (!last || samples.length < 2) return;
  const start = last.ts - TRACE_WINDOW_US;
  const values = samples.map((s) => s.value);
  const min = Math.min(...values);
  const span = Math.max(Math.max(...values) - min, 1e-6);
  ctx.strokeStyle = '#6fd3b2';
  ctx.lineWidth = 2;
  ctx.beginPath();
  samples.forEach((s, i) => {
    const x = ((s.ts - start) / TRACE_WINDOW_US) * width;
    const y = height - 8 - ((s.value - min) / span) * (height - 16);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

export function DebugPanel({ bridge }: { bridge: SignalBridge }) {
  const [mode, setMode] = useState<Mode>('idle');
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [recordings, setRecordings] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  const [recordMetrics, setRecordMetrics] = useState(false);
  const [recordingPath, setRecordingPath] = useState<string | null>(null);
  const [processing, setProcessing] = useState('Idle');
  const [validation, setValidation] = useState('Not running');
  const [talking, setTalking] = useState<boolean | null>(null);
  const [traceCount, setTraceCount] = useState(0);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const sourceRef = useRef<SignalSource | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const traceRef = useRef<TraceSample[]>([]);
  const talkingAtRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  const videoRef = useRef<HTMLVideoElement>(null);

  const refreshRecordings = useCallback(async () => {
    const names = await bridge.listRecordings();
    setRecordings(names);
    setSelected((current) => (current && names.includes(current) ? current : (names[0] ?? '')));
  }, [bridge]);

  useEffect(() => {
    void bridge.hasApiKey().then(setHasKey);
    void refreshRecordings();
  }, [bridge, refreshRecordings]);

  const onEvent = useCallback(
    (event: SignalEvent, recording: boolean) => {
      if (recording) bridge.recorderAppend(event);
      switch (event.t) {
        case 'metrics': {
          if (event.upperTrace.length > 0) {
            const cutoff = (event.upperTrace[event.upperTrace.length - 1]?.ts ?? 0) - TRACE_WINDOW_US;
            traceRef.current = [...traceRef.current, ...event.upperTrace].filter((s) => s.ts >= cutoff);
            setTraceCount((n) => n + event.upperTrace.length);
            if (canvasRef.current) drawTrace(canvasRef.current, traceRef.current);
          }
          const latest = event.talking[event.talking.length - 1];
          if (latest) {
            talkingAtRef.current = latest.ts;
            setTalking(latest.detected);
          } else if (event.ts - talkingAtRef.current > TALKING_FRESH_US) {
            setTalking(null);
          }
          break;
        }
        case 'validation':
          setValidation(`${VALIDATION_NAMES[event.code] ?? `Code ${event.code}`}${event.hint ? `: ${event.hint}` : ''}`);
          break;
        case 'processing':
          setProcessing(PROCESSING_NAMES[event.status] ?? `Status ${event.status}`);
          // The SDK keeps the camera open in its error state, so release it.
          if (event.status === PROCESSING_ERROR && sourceRef.current?.kind === 'live') {
            void stopRef.current().then(() => setNotice('Camera stopped after an SDK error.'));
          }
          break;
        case 'error':
          setErrorText(`SDK error ${event.code}: ${event.message}${event.retryable ? ' (retryable)' : ''}`);
          break;
      }
    },
    [bridge],
  );

  const reset = () => {
    traceRef.current = [];
    talkingAtRef.current = 0;
    setTraceCount(0);
    setTalking(null);
    setErrorText(null);
    setNotice(null);
    setRecordingPath(null);
    const canvas = canvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
  };

  const finish = useCallback(async () => {
    unsubRef.current?.();
    unsubRef.current = null;
    sourceRef.current = null;
    await bridge.recorderStop();
    setMode('idle');
    setProcessing('Idle');
    setValidation('Not running');
    void refreshRecordings();
  }, [bridge, refreshRecordings]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await sourceRef.current?.stop();
    } catch (err) {
      setErrorText(String(err));
    } finally {
      await finish();
      setBusy(false);
    }
  }, [finish]);
  stopRef.current = stop;

  // Consent: this handler is the only route to starting the camera, and it needs a click.
  const startLive = async () => {
    setBusy(true);
    reset();
    const source = new LiveSource({
      getApiKey: () => bridge.getApiKey(),
      enableTelemetry: false,
      onStream: (stream) => {
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          if (stream) void videoRef.current.play().catch(() => undefined);
        }
      },
      onAutoStop: () => {
        void finish().then(() => setNotice('Camera stopped by the 15 minute session limit.'));
      },
    });
    const recording = recordMetrics;
    sourceRef.current = source;
    unsubRef.current = source.subscribe((event) => onEvent(event, recording));
    try {
      if (recording) setRecordingPath(await bridge.recorderStart());
      setMode('live');
      await source.start();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
      await finish();
    } finally {
      setBusy(false);
    }
  };

  const startReplay = async () => {
    setBusy(true);
    reset();
    try {
      const recording = parseRecording(await bridge.readRecording(selected));
      const source = new ReplaySource(recording, {
        onEnd: () => {
          void finish().then(() => setNotice('Sample recording finished.'));
        },
      });
      sourceRef.current = source;
      unsubRef.current = source.subscribe((event) => onEvent(event, false));
      setMode('replay');
      setProcessing('Replaying');
      if (recording.header.origin === 'synthetic') setNotice('This file is generated test data, not a real session.');
      await source.start();
    } catch (err) {
      setErrorText(err instanceof Error ? err.message : String(err));
      await finish();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    // Releases the camera if the window goes away.
    const release = () => void sourceRef.current?.stop();
    window.addEventListener('beforeunload', release);
    return () => window.removeEventListener('beforeunload', release);
  }, []);

  const talkingText = talking === null ? 'No reading yet' : talking ? 'Talking' : 'Not talking';

  return (
    <section className="panel">
      <header className="panel-head">
        <h2>Live signal</h2>
        {mode === 'live' && (
          <span className="badge badge-on" role="status">
            ● Camera on
          </span>
        )}
        {mode === 'replay' && (
          <span className="badge badge-sample" role="status">
            {SAMPLE_LABEL}
          </span>
        )}
        {mode === 'idle' && <span className="badge">Camera off</span>}
      </header>

      <div className="controls">
        {mode === 'live' ? (
          <button onClick={() => void stop()} disabled={busy}>
            Stop camera
          </button>
        ) : (
          <button onClick={() => void startLive()} disabled={busy || mode !== 'idle' || !hasKey}>
            Turn on camera
          </button>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={recordMetrics}
            disabled={mode !== 'idle'}
            onChange={(e) => setRecordMetrics(e.target.checked)}
          />
          Save metrics to a local file (never video)
        </label>
      </div>

      <div className="controls">
        <select
          value={selected}
          disabled={mode !== 'idle' || recordings.length === 0}
          onChange={(e) => setSelected(e.target.value)}
          aria-label="Sample recording"
        >
          {recordings.length === 0 && <option value="">No recordings</option>}
          {recordings.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        {mode === 'replay' ? (
          <button onClick={() => void stop()} disabled={busy}>
            Stop sample
          </button>
        ) : (
          <button onClick={() => void startReplay()} disabled={busy || mode !== 'idle' || !selected}>
            Use sample recording
          </button>
        )}
      </div>

      {!hasKey && <p className="note">No API key found. Add PRESAGE_API_KEY to .env to use the camera. Sample recordings work without one.</p>}
      {recordingPath && <p className="note">Saving metrics to {recordingPath}</p>}
      {notice && <p className="note">{notice}</p>}
      {errorText && (
        <p className="error" role="alert">
          {errorText}
        </p>
      )}

      <div className="live-grid">
        <video ref={videoRef} className={mode === 'live' ? 'preview' : 'preview hidden'} muted playsInline />
        <dl className="readouts">
          <dt>SDK status</dt>
          <dd data-testid="processing">{processing}</dd>
          <dt>Camera hint</dt>
          <dd data-testid="validation">{validation}</dd>
          <dt>Talking</dt>
          <dd data-testid="talking">{talkingText}</dd>
          <dt>Trace samples</dt>
          <dd data-testid="trace-count">{traceCount}</dd>
        </dl>
      </div>

      <h3>Breathing trace (last 30 s)</h3>
      <canvas ref={canvasRef} className="trace" width={880} height={160} />
    </section>
  );
}
