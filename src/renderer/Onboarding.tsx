import { useEffect, useState } from 'react';
import type { Settings } from '../shared/types';
import { CameraPreview, useCameraHint } from '../signals/debug-panel';
import type { SignalHost } from '../signals/host';
import { SamplePicker, useHostMessages } from './App';

type Step = 'welcome' | 'data' | 'key' | 'camera' | 'calibrate';
const CALIBRATE_MS = 2 * 60_000;
const bridge = () => window.flowstate;

type Props = { host: SignalHost; settings: Settings; onDone: (s: Settings) => void; onSettings: (s: Settings) => void };

export function Onboarding({ host, settings, onDone, onSettings }: Props) {
  const [step, setStep] = useState<Step>('welcome');
  const finish = () => void bridge().updateSettings({ onboarded: true }).then(onDone);

  return (
    <main className="onboarding">
      <h1>FlowState</h1>
      {step === 'welcome' && (
        <section className="panel">
          <h2>Protect your focus</h2>
          <ul className="consent">
            <li>Notices when you are in sustained focus, using your webcam and the Presage SmartSpectra SDK.</li>
            <li>Later versions will quiet your notifications and tell your coding agents to wait.</li>
            <li>Shows you when you focus best. Only you can see it.</li>
          </ul>
          <p className="strong">Not a medical device.</p>
          <button onClick={() => setStep('data')}>Next</button>
        </section>
      )}
      {step === 'data' && (
        <section className="panel">
          <h2>Your data</h2>
          <dl className="data-list">
            <dt>Camera</dt>
            <dd>Off until you click Turn on camera. A red ring on the tray icon and a badge here show when it is on. By default it runs 60 seconds every 5 minutes.</dd>
            <dt>Video</dt>
            <dd>Frames are processed on this computer by the SDK. FlowState never saves or uploads them.</dd>
            <dt>Stored here</dt>
            <dd>Settings, your SDK minutes for the day, and your API key, encrypted by your OS keychain.</dd>
            <dt>Never stored</dt>
            <dd>Video and images. Breathing values are stored only if you tick Save metrics in the live signal panel, in a local file you can delete.</dd>
            <dt>Network</dt>
            <dd>The SDK connects to Presage to validate your API key and fetch the models it runs on this computer. FlowState adds no other network calls and no AI services.</dd>
            <dt>Deleting</dt>
            <dd>Settings has Delete all data. It removes everything listed above.</dd>
          </dl>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.telemetry}
              onChange={(e) => void bridge().updateSettings({ telemetry: e.target.checked }).then(onSettings)}
            />
            Share SDK telemetry with Presage. Off by default.
          </label>
          <p className="note">
            If on, the SDK sends one summary per session: SDK version, platform, OS version, device model, frame rate and timing counts, counts of camera warnings, and a coarse error code. It never includes video, measured values, or user or device identifiers.
          </p>
          <button onClick={() => setStep('key')}>I understand, next</button>
        </section>
      )}
      {step === 'key' && <KeyStep host={host} onNext={() => setStep('camera')} onSample={finish} />}
      {step === 'camera' && (
        <section className="panel">
          <h2>Turn on the camera</h2>
          <p>Next, FlowState watches for 2 minutes while you work quietly, to learn your own baseline.</p>
          <div className="controls">
            <button
              onClick={() => {
                setStep('calibrate');
                void host.startSensing(CALIBRATE_MS);
              }}
            >
              Turn on camera
            </button>
            <button onClick={finish}>Skip for now</button>
          </div>
        </section>
      )}
      {step === 'calibrate' && <Calibrate host={host} onDone={finish} />}
    </main>
  );
}

function KeyStep({ host, onNext, onSample }: { host: SignalHost; onNext: () => void; onSample: () => void }) {
  const [key, setKey] = useState('');
  const [hasKey, setHasKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void bridge().hasApiKey().then(setHasKey);
  }, []);
  return (
    <section className="panel">
      <h2>Presage API key</h2>
      {hasKey && <p className="note">A key is already set up.</p>}
      <div className="controls">
        <input type="password" className="key-input" value={key} placeholder="Paste your API key" onChange={(e) => setKey(e.target.value)} aria-label="Presage API key" />
        <button
          disabled={!key.trim()}
          onClick={() => {
            void bridge()
              .saveApiKey(key)
              .then((result) => {
                if (result.ok) onNext();
                else setError(result.reason);
              });
            setKey('');
          }}
        >
          Save to keychain
        </button>
        {hasKey && <button onClick={onNext}>Use the existing key</button>}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3>No key? Try it without the camera</h3>
      <SamplePicker host={host} onStart={onSample} />
    </section>
  );
}

function Calibrate({ host, onDone }: { host: SignalHost; onDone: () => void }) {
  const hint = useCameraHint(host);
  const message = useHostMessages(host);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Date.now() - started), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (elapsed >= CALIBRATE_MS) onDone();
  }, [elapsed, onDone]);
  return (
    <section className="panel">
      <h2>Learning your baseline</h2>
      <span className="badge badge-on" role="status">
        ● Camera on
      </span>
      <p>Work as you normally do. Keep your face in frame and your chest visible if you can.</p>
      <p data-testid="calibrate-hint">Camera: {hint}</p>
      <progress max={CALIBRATE_MS} value={elapsed} />
      <CameraPreview host={host} />
      {message && <p className={message.kind === 'error' ? 'error' : 'note'}>{message.text}</p>}
      <div className="controls">
        <button onClick={onDone}>Finish early</button>
        <button
          onClick={() => {
            void host.stopSensing().then(onDone);
          }}
        >
          Stop camera
        </button>
      </div>
    </section>
  );
}
