// "Live signal" debug panel, opt-in. It lives in signals/ because it is the only UI allowed to
// see raw values. It draws the breathing trace and the talking flag, and shows no vitals numbers.
import { useEffect, useRef, useState } from 'react';
import type { SignalHost } from './host';
import { PROCESSING_NAMES, VALIDATION_NAMES, type TraceSample } from './types';

const TRACE_WINDOW_US = 30_000_000;

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

export function useCameraHint(host: SignalHost): string {
  const [hint, setHint] = useState('Waiting for the camera');
  useEffect(
    () =>
      host.subscribe((event) => {
        if (event.t === 'validation') setHint(VALIDATION_NAMES[event.code] ?? `Code ${event.code}`);
      }),
    [host],
  );
  return hint;
}

export function CameraPreview({ host }: { host: SignalHost }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  useEffect(
    () =>
      host.onStream((stream) => {
        setOn(stream !== null);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          if (stream) void videoRef.current.play().catch(() => undefined);
        }
      }),
    [host],
  );
  return <video ref={videoRef} className={on ? 'preview' : 'preview hidden'} muted playsInline />;
}

export function DebugPanel({ host, disabled }: { host: SignalHost; disabled: boolean }) {
  const [processing, setProcessing] = useState('Idle');
  const [validation, setValidation] = useState('No reading yet');
  const [talking, setTalking] = useState<boolean | null>(null);
  const [traceCount, setTraceCount] = useState(0);
  const [record, setRecord] = useState(false);
  const traceRef = useRef<TraceSample[]>([]);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(
    () =>
      host.subscribe((event) => {
        switch (event.t) {
          case 'metrics': {
            if (event.upperTrace.length > 0) {
              const cutoff = (event.upperTrace[event.upperTrace.length - 1]?.ts ?? 0) - TRACE_WINDOW_US;
              traceRef.current = [...traceRef.current, ...event.upperTrace].filter((s) => s.ts >= cutoff);
              setTraceCount((n) => n + event.upperTrace.length);
              if (canvasRef.current) drawTrace(canvasRef.current, traceRef.current);
            }
            const latest = event.talking[event.talking.length - 1];
            if (latest) setTalking(latest.detected);
            break;
          }
          case 'validation':
            setValidation(`${VALIDATION_NAMES[event.code] ?? `Code ${event.code}`}${event.hint ? `: ${event.hint}` : ''}`);
            break;
          case 'processing':
            setProcessing(PROCESSING_NAMES[event.status] ?? `Status ${event.status}`);
            break;
          case 'error':
            setValidation(`SDK error ${event.code}: ${event.message}${event.retryable ? ' (will retry next sample)' : ''}`);
            break;
        }
      }),
    [host],
  );

  const talkingText = talking === null ? 'No reading yet' : talking ? 'Talking' : 'Not talking';

  return (
    <section className="panel">
      <h2>Live signal</h2>
      <label className="check">
        <input
          type="checkbox"
          checked={record}
          disabled={disabled}
          onChange={(e) => {
            setRecord(e.target.checked);
            host.setRecordMetrics(e.target.checked);
          }}
        />
        Save metrics to a local file next time the camera turns on (never video)
      </label>
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
      <h3>Breathing trace (last 30 s)</h3>
      <canvas ref={canvasRef} className="trace" width={880} height={160} />
    </section>
  );
}
