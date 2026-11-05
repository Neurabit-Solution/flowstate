import { useCallback, useEffect, useState } from 'react';
import type { DayTimeline, DevEvent, DevState, TimelineInsights, WeekHeatmap } from '../shared/types';

const bridge = () => window.flowstate;
const DAY_MS = 24 * 60 * 60_000;

const STATE: Partial<Record<DevState, { label: string; color: string }>> = {
  focused: { label: 'Focus', color: '#9a7bf0' },
  available: { label: 'Available', color: '#4f9f7f' },
  talking: { label: 'In a conversation', color: '#5a8fd8' },
  away: { label: 'Away', color: '#4a5060' },
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const MARKER: Record<DevEvent['kind'], { color: string; label: string }> = {
  commit: { color: '#e6e8ee', label: 'Commit' },
  branch_switch: { color: '#a4abbd', label: 'Branch switch' },
  test_run: { color: '#d9bd5f', label: 'Test run' },
  build: { color: '#e08a4f', label: 'Build' },
  ci_run: { color: '#7fb0f0', label: 'CI' },
  agent_message: { color: '#6fd3b2', label: 'Agent message' },
};

function describe(e: DevEvent): string {
  const d = e.detail;
  const when = clock(e.ts);
  switch (e.kind) {
    case 'commit':
      return `${when} commit in ${e.repo}: ${String(d.message)}${d.filesChanged != null ? ` (${String(d.filesChanged)} files)` : ''}`;
    case 'branch_switch':
      return `${when} switched to ${String(d.to)} in ${e.repo}`;
    case 'agent_message':
      return `${when} held message from ${String(d.source)}`;
    default:
      return `${when} ${MARKER[e.kind].label.toLowerCase()} ${String(d.command ?? '')}: exit ${String(d.exitCode)}, ${Math.round(Number(d.durationMs) / 1000)} s`;
  }
}

function DayBand({ day }: { day: DayTimeline }) {
  const W = 880;
  const span = day.dayEnd - day.dayStart;
  const x = (ms: number) => (Math.min(Math.max(ms, day.dayStart), day.dayEnd) - day.dayStart) / span * W;
  return (
    <svg className="day-band" viewBox={`0 0 ${W} 84`} role="img" aria-label="Your day">
      {[0, 6, 12, 18].map((h) => {
        const hx = (h / 24) * W;
        return (
          <g key={h}>
            <line x1={hx} x2={hx} y1={0} y2={84} stroke="#2a2f3d" />
            <text x={hx + 3} y={80}>{`${String(h).padStart(2, '0')}:00`}</text>
          </g>
        );
      })}
      {day.spans.map((s) => {
        const info = STATE[s.state];
        if (!info) return null;
        const sample = s.source === 'replay';
        return (
          <rect key={`${s.start}-${s.state}`} x={x(s.start)} y={24} width={Math.max(x(s.end) - x(s.start), 1)} height={40} fill={info.color} opacity={sample ? 0.45 : 1} data-state={s.state}>
            <title>{`${info.label}${sample ? ' (sample, not live)' : s.source === 'manual' ? ' (set by you)' : ''}: ${clock(s.start)} to ${clock(s.end)}`}</title>
          </rect>
        );
      })}
      {day.events.map((e, i) => (
        <rect key={`${e.ts}-${i}`} x={x(e.ts) - 1} y={6} width={3} height={14} fill={MARKER[e.kind].color}>
          <title>{describe(e)}</title>
        </rect>
      ))}
    </svg>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function Heatmap({ heatmap }: { heatmap: WeekHeatmap }) {
  const max = Math.max(1, ...heatmap.flat());
  const cell = 32;
  const left = 34;
  return (
    <svg className="heatmap" viewBox={`0 0 ${left + 24 * cell} ${7 * 18 + 18}`} role="img" aria-label="Focus minutes by weekday and hour">
      {DAYS.map((name, d) => (
        <text key={name} x={0} y={d * 18 + 13}>
          {name}
        </text>
      ))}
      {[0, 6, 12, 18].map((h) => (
        <text key={h} x={left + h * cell} y={7 * 18 + 12}>{`${h}:00`}</text>
      ))}
      {heatmap.map((row, d) =>
        row.map((minutes, h) => (
          <rect key={`${d}-${h}`} x={left + h * cell} y={d * 18} width={cell - 2} height={16} rx={2} fill={minutes === 0 ? '#1f232d' : '#9a7bf0'} opacity={minutes === 0 ? 1 : 0.25 + 0.75 * (minutes / max)}>
            <title>{`${DAYS[d]} ${h}:00: ${minutes} min`}</title>
          </rect>
        )),
      )}
    </svg>
  );
}

function Patterns({ insights }: { insights: TimelineInsights }) {
  if (insights.blocks === 0) return <p className="note">No focus blocks in the last 7 days.</p>;
  return (
    <ul className="insights" data-testid="insights">
      <li>
        {insights.focusMinutes} focus {insights.focusMinutes === 1 ? 'minute' : 'minutes'} across {insights.blocks} {insights.blocks === 1 ? 'block' : 'blocks'}.
      </li>
      <li>Median focus block: {insights.medianBlockMinutes} min.</li>
      <li>Longest focus blocks: {insights.longestBlocks.map((b) => `${new Date(b.start).toLocaleDateString([], { weekday: 'short' })} ${clock(b.start)}-${clock(b.end)}`).join(', ')}.</li>
      <li>Focus blocks that ended within 2 min of a build or test run longer than 5 min: {insights.blocksEndedNearLongBuild}.</li>
    </ul>
  );
}

export function TimelinePanel({ state }: { state: DevState }) {
  const [dayStart, setDayStart] = useState(() => new Date().setHours(0, 0, 0, 0));
  const [day, setDay] = useState<DayTimeline | null>(null);
  const [week, setWeek] = useState<{ heatmap: WeekHeatmap; insights: TimelineInsights } | null>(null);
  const [repos, setRepos] = useState<string[]>([]);
  const [cli, setCli] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(() => {
    void bridge().timelineDay(dayStart).then(setDay);
    void bridge().timelineWeek(Date.now()).then(setWeek);
    void bridge().listRepos().then(setRepos);
  }, [dayStart]);
  useEffect(refresh, [refresh, state]);
  useEffect(() => {
    void bridge().cliCommand().then(setCli);
  }, []);

  const today = new Date().setHours(0, 0, 0, 0);
  const shiftDay = (by: number) => setDayStart(new Date(dayStart + by * DAY_MS + 2 * 60 * 60_000).setHours(0, 0, 0, 0));

  return (
    <section className="panel">
      <h2>Timeline</h2>
      <div className="controls">
        <button onClick={() => shiftDay(-1)}>Previous day</button>
        <strong data-testid="timeline-day">{new Date(dayStart).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' })}</strong>
        <button onClick={() => shiftDay(1)} disabled={dayStart >= today}>
          Next day
        </button>
      </div>
      {day && <DayBand day={day} />}
      <div className="legend">
        {Object.values(STATE).map((s) => (
          <span key={s.label}>
            <svg width="10" height="10" aria-hidden="true">
              <rect width="10" height="10" fill={s.color} />
            </svg>{' '}
            {s.label}
          </span>
        ))}
        <span>Faded means a sample recording.</span>
      </div>
      {day && day.events.length > 0 && (
        <ul className="integration-log" data-testid="timeline-events">
          {day.events.slice(-10).reverse().map((e, i) => (
            <li key={`${e.ts}-${i}`}>{describe(e)}</li>
          ))}
        </ul>
      )}
      <h3>Last 7 days</h3>
      {week && <Heatmap heatmap={week.heatmap} />}
      {week && <Patterns insights={week.insights} />}

      <h3>Git repositories</h3>
      {repos.length === 0 && <p className="note">None yet. Commits and branch switches from now on appear above. Earlier history stays out.</p>}
      {repos.map((repo) => (
        <div className="repo-row" key={repo}>
          <span>{repo}</span>
          <button onClick={() => void bridge().removeRepo(repo).then(refresh)}>Remove</button>
        </div>
      ))}
      <div className="controls">
        <button
          onClick={() => {
            void bridge()
              .addRepo()
              .then((error) => {
                setMessage(error);
                refresh();
              });
          }}
        >
          Add repository
        </button>
      </div>

      <h3>Tests and builds</h3>
      <p className="note">Run a command through FlowState to record when it ran and how it ended. Its output and exit code do not change.</p>
      <div className="snippet">
        <pre>{cli}</pre>
      </div>

      <div className="controls">
        <button
          onClick={() => {
            void bridge()
              .timelineExport()
              .then((path) => setMessage(path ? `Saved to ${path}` : null));
          }}
        >
          Export CSV
        </button>
        <button
          className="danger"
          onClick={() => {
            if (window.confirm('Delete everything on the timeline for this day?')) void bridge().timelineDeleteDay(dayStart).then(refresh);
          }}
        >
          Delete this day
        </button>
      </div>
      {message && <p className="note">{message}</p>}
    </section>
  );
}
