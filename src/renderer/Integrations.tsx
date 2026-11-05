import { useCallback, useEffect, useState } from 'react';
import type { AppStatus, IntegrationLogEntry, IntegrationView } from '../shared/types';

const bridge = () => window.flowstate;

export function IntegrationsPanel({ status }: { status: AppStatus }) {
  const [items, setItems] = useState<IntegrationView[]>([]);
  const [log, setLog] = useState<IntegrationLogEntry[]>([]);
  const [results, setResults] = useState<Record<string, string>>({});
  const refresh = useCallback(() => {
    void bridge().listIntegrations().then(setItems);
    void bridge().integrationLog().then(setLog);
  }, []);
  // The status updates often, and focus changes are what add log entries.
  useEffect(refresh, [refresh, status.state]);

  const test = (id: string) => {
    void bridge()
      .testIntegration(id)
      .then((r) => setResults((all) => ({ ...all, [id]: `${r.ok ? 'OK' : 'Problem'}: ${r.detail}` })));
  };

  return (
    <section className="panel">
      <h2>Integrations</h2>
      <p className="note">Each one runs only while you are in focus and puts things back afterwards. It never posts to channels. Sample recordings only log what would happen.</p>
      {items.map((item) => (
        <div className="integration" key={item.id} data-testid={`integration-${item.id}`}>
          <label className="check">
            <input
              type="checkbox"
              checked={item.enabled}
              onChange={(e) => {
                void bridge().setIntegrationEnabled(item.id, e.target.checked).then(refresh);
              }}
            />
            {item.label}
          </label>
          <span className="note">{item.ready ? 'Ready' : item.id === 'os-focus' ? 'Manual on this system' : 'Not connected'}</span>
          <button onClick={() => test(item.id)}>Test</button>
          {item.id !== 'os-focus' && item.ready && (
            <button
              onClick={() => {
                void bridge().disconnectIntegration(item.id).then(refresh);
              }}
            >
              Disconnect
            </button>
          )}
          {results[item.id] && (
            <p className="note integration-result" data-testid={`result-${item.id}`}>
              {results[item.id]}
            </p>
          )}
          {item.id === 'slack' && !item.ready && <SlackConnect onDone={refresh} />}
          {item.id === 'gcal' && !item.ready && <GoogleConnect onDone={refresh} />}
        </div>
      ))}
      <h3>Log</h3>
      {log.length === 0 && <p className="note">Nothing yet.</p>}
      <ul className="integration-log" data-testid="integration-log">
        {log
          .slice(-12)
          .reverse()
          .map((entry, i) => (
            <li key={`${entry.ts}-${i}`} className={entry.ok ? '' : 'log-bad'}>
              {new Date(entry.ts).toLocaleTimeString()} {entry.integration}: {entry.action}
              {entry.ok ? '' : ` failed. ${entry.error ?? ''}`}
            </li>
          ))}
      </ul>
    </section>
  );
}

function SlackConnect({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="controls integration-result">
      <input type="password" className="key-input" value={token} placeholder="Slack user token (xoxp-...)" aria-label="Slack user token" onChange={(e) => setToken(e.target.value)} />
      <button
        disabled={!token.trim()}
        onClick={() => {
          void bridge()
            .saveSlackToken(token)
            .then((r) => {
              if (r.ok) onDone();
              else setError(r.reason);
            });
          setToken('');
        }}
      >
        Save to keychain
      </button>
      {error && <p className="error">{error}</p>}
    </div>
  );
}

function GoogleConnect({ onDone }: { onDone: () => void }) {
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="controls integration-result">
      <input className="key-input" value={clientId} placeholder="OAuth client ID" aria-label="Google client ID" onChange={(e) => setClientId(e.target.value)} />
      <input type="password" className="key-input" value={secret} placeholder="OAuth client secret" aria-label="Google client secret" onChange={(e) => setSecret(e.target.value)} />
      <button
        disabled={!clientId.trim() || !secret.trim()}
        onClick={() => {
          setMessage('Finish signing in in your browser.');
          void bridge()
            .connectGoogle(clientId, secret)
            .then((r) => {
              if (r.ok) onDone();
              else setMessage(r.reason);
            });
        }}
      >
        Sign in with Google
      </button>
      {message && <p className="note">{message}</p>}
    </div>
  );
}
