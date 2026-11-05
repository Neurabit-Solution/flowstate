import { useEffect, useState } from 'react';
import type { AppStatus, DevState, Settings } from '../shared/types';
import { CameraPreview, DebugPanel } from '../signals/debug-panel';
import { REPLAY_SPEED, type HostMessage, type SignalHost } from '../signals/host';
import { SAMPLE_LABEL } from '../signals/replay';
import { Onboarding } from './Onboarding';

const bridge = () => window.flowstate;

const STATE_LABEL: Record<DevState, string> = {
  off: 'Off',
  warming_up: 'Warming up',
  away: 'Away',
  talking: 'In a conversation',
  available: 'Available',
  focused: 'Focus',
};

export function App({ host }: { host: SignalHost }) {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    void bridge().getSettings().then(setSettings);
  }, []);
  if (!settings) return null;
  if (!settings.onboarded) {
    return <Onboarding host={host} settings={settings} onDone={setSettings} onSettings={setSettings} />;
  }
  return <Home host={host} settings={settings} onSettings={setSettings} />;
}

export function useStatus(): AppStatus | null {
  const [status, setStatus] = useState<AppStatus | null>(null);
  useEffect(() => {
    void bridge().getStatus().then(setStatus);
    return bridge().onStatus(setStatus);
  }, []);
  return status;
}

export function useHostMessages(host: SignalHost): HostMessage | null {
  const [message, setMessage] = useState<HostMessage | null>(null);
  useEffect(() => host.onMessage(setMessage), [host]);
  return message;
}

export function SamplePicker({ host, onStart }: { host: SignalHost; onStart?: () => void }) {
  const [names, setNames] = useState<string[]>([]);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    void bridge()
      .listRecordings()
      .then((list) => {
        setNames(list);
        setSelected(list[0] ?? '');
      });
  }, []);
  return (
    <div className="controls">
      <select value={selected} onChange={(e) => setSelected(e.target.value)} aria-label="Sample recording" disabled={names.length === 0}>
        {names.length === 0 && <option value="">No recordings</option>}
        {names.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
      <button
        disabled={!selected}
        onClick={() => {
          onStart?.();
          void host.startReplay(selected);
        }}
      >
        Use sample recording
      </button>
    </div>
  );
}

function Home({ host, settings, onSettings }: { host: SignalHost; settings: Settings; onSettings: (s: Settings) => void }) {
  const status = useStatus();
  const message = useHostMessages(host);
  const [hasKey, setHasKey] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  useEffect(() => {
    void bridge().hasApiKey().then(setHasKey);
  }, [settings]);
  if (!status) return null;

  const live = status.source === 'live';
  const replay = status.source === 'replay';
  const manual = status.override === 'focus' || status.override === 'free';

  return (
    <main>
      <header className="top">
        <h1>FlowState</h1>
        {status.cameraOn && (
          <span className="badge badge-on" role="status">
            ● Camera on
          </span>
        )}
        {live && !status.cameraOn && <span className="badge">Sensing on, camera off until the next sample</span>}
        {replay && (
          <span className="badge badge-sample" role="status">
            {SAMPLE_LABEL}
          </span>
        )}
        {!live && !replay && <span className="badge">Camera off</span>}
        {status.demo && <span className="badge">Demo timing</span>}
      </header>

      <section className="panel state-panel">
        <div className="state" data-testid="state" data-state={status.state}>
          {STATE_LABEL[status.state]}
        </div>
        <p className="note">
          {manual ? 'Set by you.' : replay ? `Playing at ${REPLAY_SPEED}x speed.` : status.state === 'off' ? 'Sensing is off.' : 'Set automatically.'}
        </p>
        <div className="controls">
          {live ? (
            <button onClick={() => void host.stopSensing()}>Stop camera</button>
          ) : replay ? (
            <button onClick={() => void host.stopReplay()}>Stop sample</button>
          ) : (
            <button onClick={() => void host.startSensing()} disabled={!hasKey}>
              Turn on camera
            </button>
          )}
          <button onClick={() => bridge().setOverride(status.override === 'focus' ? null : 'focus')} className={status.override === 'focus' ? 'pressed' : ''}>
            I'm focusing
          </button>
          <button onClick={() => bridge().setOverride(status.override === 'free' ? null : 'free')} className={status.override === 'free' ? 'pressed' : ''}>
            I'm free
          </button>
          {live && (
            <>
              <button onClick={() => bridge().setOverride('paused', 15)}>Pause 15 min</button>
              <button onClick={() => bridge().setOverride('paused', 60)}>Pause 1 h</button>
            </>
          )}
          {status.override === 'paused' && <button onClick={() => bridge().setOverride(null)}>End pause</button>}
        </div>
        {!hasKey && <p className="note">No API key found, so the camera is unavailable. Sample recordings work without one.</p>}
        {!live && !replay && <SamplePicker host={host} />}
        <p className="note" data-testid="sdk-minutes">
          SDK minutes today: {status.sdkMinutesToday}
          {status.overDailyCap ? `. Over your daily limit of ${settings.dailyCapMinutes}.` : ''}
        </p>
        {message && (
          <p className={message.kind === 'error' ? 'error' : 'note'} role={message.kind === 'error' ? 'alert' : undefined}>
            {message.text}
          </p>
        )}
        <CameraPreview host={host} />
      </section>

      <div className="controls">
        <button onClick={() => setShowDebug(!showDebug)}>{showDebug ? 'Hide live signal' : 'Show live signal'}</button>
        <button onClick={() => setShowSettings(!showSettings)}>{showSettings ? 'Hide settings' : 'Settings'}</button>
      </div>
      {showDebug && <DebugPanel host={host} disabled={live || replay} />}
      {showSettings && <SettingsPanel settings={settings} onSettings={onSettings} locked={live} />}
    </main>
  );
}

function ReplaceKey() {
  const [key, setKey] = useState('');
  const [result, setResult] = useState<string | null>(null);
  return (
    <div className="controls">
      <input type="password" className="key-input" value={key} placeholder="Replace your API key" onChange={(e) => setKey(e.target.value)} aria-label="Replace Presage API key" />
      <button
        disabled={!key.trim()}
        onClick={() => {
          void bridge()
            .saveApiKey(key)
            .then((r) => setResult(r.ok ? 'Saved to the keychain. It applies next time the camera turns on.' : r.reason));
          setKey('');
        }}
      >
        Save to keychain
      </button>
      {result && <p className="note">{result}</p>}
    </div>
  );
}

const NUMBER_FIELDS: { key: 'sampleSeconds' | 'everyMinutes' | 'focusEnterMinutes' | 'dailyCapMinutes'; label: string; min: number }[] = [
  { key: 'sampleSeconds', label: 'Sample length (seconds)', min: 15 },
  { key: 'everyMinutes', label: 'Sample every (minutes)', min: 1 },
  { key: 'focusEnterMinutes', label: 'Minutes before focus starts', min: 1 },
  { key: 'dailyCapMinutes', label: 'Warn after this many SDK minutes a day', min: 1 },
];

function SettingsPanel({ settings, onSettings, locked }: { settings: Settings; onSettings: (s: Settings) => void; locked: boolean }) {
  const update = (patch: Partial<Settings>) => void bridge().updateSettings(patch).then(onSettings);
  return (
    <section className="panel">
      <h2>Settings</h2>
      {locked && <p className="note">Stop the camera to change sampling. Changes apply next time it turns on.</p>}
      {NUMBER_FIELDS.map(({ key, label, min }) => (
        <label className="field" key={key}>
          {label}
          <input
            type="number"
            min={min}
            value={settings[key]}
            disabled={locked}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (Number.isFinite(value) && value >= min) update({ [key]: value });
            }}
          />
        </label>
      ))}
      <ReplaceKey />
      <label className="check">
        <input type="checkbox" checked={settings.telemetry} disabled={locked} onChange={(e) => update({ telemetry: e.target.checked })} />
        Share SDK telemetry with Presage (off by default)
      </label>
      <div className="controls">
        <button
          className="danger"
          onClick={() => {
            if (window.confirm('Delete your saved API key, settings, SDK minutes and any saved metric files?')) {
              void bridge()
                .deleteLocalData()
                .then(() => bridge().getSettings().then(onSettings));
            }
          }}
        >
          Delete all data
        </button>
      </div>
    </section>
  );
}
