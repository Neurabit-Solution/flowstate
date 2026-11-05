import { useEffect, useState } from 'react';
import type { AppStatus, PulseInfo } from '../shared/types';

const bridge = () => window.flowstate;

function Snippet({ title, hint, text }: { title: string; hint: string; text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="snippet">
      <h3>{title}</h3>
      <p className="note">{hint}</p>
      <pre>{text}</pre>
      <button
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => setCopied(true));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </div>
  );
}

export function AgentsPanel({ status }: { status: AppStatus }) {
  const [info, setInfo] = useState<PulseInfo | null>(null);
  useEffect(() => {
    void bridge().pulseInfo().then(setInfo);
  }, [status]);
  if (!info) return null;
  return (
    <section className="panel">
      <h2>Coding agents</h2>
      <p className="note">
        Pulse tells your agents only your state, since when, your focus minutes and the queue of messages they left. It runs on this computer only. {info.running ? 'Running.' : 'Not running.'}
      </p>
      <h3>Held messages ({info.held.length})</h3>
      {info.held.length === 0 && <p className="note">None.</p>}
      <ul className="integration-log" data-testid="held-messages">
        {info.held.map((m) => (
          <li key={`${m.ts}-${m.source}`}>
            {new Date(m.ts).toLocaleTimeString()} {m.source} ({m.priority}): {m.text}
          </li>
        ))}
      </ul>
      <Snippet title="Claude Code" hint="Run this in a terminal." text={info.claudeCommand} />
      <Snippet title="Cursor" hint="Add to .cursor/mcp.json." text={info.cursorConfig} />
      <Snippet title="Copilot CLI" hint="Add to ~/.copilot/mcp-config.json." text={info.copilotConfig} />
      <p className="note">Then paste AGENTS-SNIPPET.md from the project into your CLAUDE.md or agent rules.</p>
    </section>
  );
}
