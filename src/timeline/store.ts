// The private timeline. Only state changes and dev events go in, in a local SQLite file.
// It takes DevState values, so it has no way to store raw signals.
import { DatabaseSync } from 'node:sqlite';
import type { DevEvent, DevEventKind, DevState, SpanSource, StateSpan, TimelineInsights, WeekHeatmap } from '../shared/types';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** Off and warming up are gaps in the timeline, not states worth storing. */
const STORED: ReadonlySet<DevState> = new Set(['away', 'talking', 'available', 'focused']);
const LONG_BUILD_MS = 5 * MIN;
const BUILD_NEAR_MS = 2 * MIN;

export const startOfLocalDay = (ms: number): number => new Date(ms).setHours(0, 0, 0, 0);
const nextLocalDay = (ms: number): number => {
  const d = new Date(startOfLocalDay(ms));
  d.setDate(d.getDate() + 1);
  return d.getTime();
};

export class TimelineStore {
  private readonly db: DatabaseSync;
  private openSpan: { id: number; state: DevState; source: SpanSource } | null = null;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS state_spans (
        id INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        start_ts INTEGER NOT NULL,
        end_ts INTEGER NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('live', 'manual', 'replay'))
      );
      CREATE INDEX IF NOT EXISTS state_spans_start ON state_spans (start_ts);
      CREATE TABLE IF NOT EXISTS dev_events (
        id INTEGER PRIMARY KEY,
        ts INTEGER NOT NULL,
        kind TEXT NOT NULL,
        repo TEXT,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dev_events_ts ON dev_events (ts);
      CREATE TABLE IF NOT EXISTS watched_repos (path TEXT PRIMARY KEY, log_offset INTEGER NOT NULL);
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Call on every status update. A new row starts only when the state or source changes. */
  recordState(state: DevState, source: SpanSource, ts: number): void {
    const open = this.openSpan;
    if (open && open.state === state && open.source === source) {
      this.db.prepare('UPDATE state_spans SET end_ts = ? WHERE id = ?').run(ts, open.id);
      return;
    }
    if (open) this.db.prepare('UPDATE state_spans SET end_ts = ? WHERE id = ?').run(ts, open.id);
    this.openSpan = null;
    if (!STORED.has(state)) return;
    const result = this.db.prepare('INSERT INTO state_spans (state, start_ts, end_ts, source) VALUES (?, ?, ?, ?)').run(state, ts, ts, source);
    this.openSpan = { id: Number(result.lastInsertRowid), state, source };
  }

  addEvent(ts: number, kind: DevEventKind, repo: string | null, detail: Record<string, unknown>): void {
    this.db.prepare('INSERT INTO dev_events (ts, kind, repo, detail_json) VALUES (?, ?, ?, ?)').run(ts, kind, repo, JSON.stringify(detail));
  }

  spans(from: number, to: number): StateSpan[] {
    const rows = this.db.prepare('SELECT state, start_ts, end_ts, source FROM state_spans WHERE end_ts >= ? AND start_ts < ? ORDER BY start_ts').all(from, to) as {
      state: DevState;
      start_ts: number;
      end_ts: number;
      source: SpanSource;
    }[];
    return rows.map((r) => ({ state: r.state, start: r.start_ts, end: r.end_ts, source: r.source }));
  }

  events(from: number, to: number): DevEvent[] {
    const rows = this.db.prepare('SELECT ts, kind, repo, detail_json FROM dev_events WHERE ts >= ? AND ts < ? ORDER BY ts').all(from, to) as {
      ts: number;
      kind: DevEventKind;
      repo: string | null;
      detail_json: string;
    }[];
    return rows.map((r) => ({ ts: r.ts, kind: r.kind, repo: r.repo, detail: JSON.parse(r.detail_json) as Record<string, unknown> }));
  }

  /** Real focus only. Sample recordings never count toward your own patterns. */
  focusBlocks(from: number, to: number): { start: number; end: number }[] {
    return this.spans(from, to)
      .filter((s) => s.state === 'focused' && s.source !== 'replay')
      .map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) }))
      .filter((b) => b.end > b.start);
  }

  /** Focus minutes by weekday (0 is Sunday) and local hour. */
  weekHeatmap(from: number, to: number): WeekHeatmap {
    const cells = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    for (const block of this.focusBlocks(from, to)) {
      let t = block.start;
      while (t < block.end) {
        const d = new Date(t);
        const nextHour = new Date(d).setMinutes(60, 0, 0);
        const until = Math.min(nextHour, block.end);
        cells[d.getDay()]![d.getHours()]! += (until - t) / MIN;
        t = until;
      }
    }
    return cells.map((row) => row.map(Math.round));
  }

  /** Patterns only, by plain rules. No judgments and no LLM. */
  insights(from: number, to: number): TimelineInsights {
    const blocks = this.focusBlocks(from, to).sort((a, b) => b.end - b.start - (a.end - a.start));
    const minutes = blocks.map((b) => (b.end - b.start) / MIN).sort((a, b) => a - b);
    const mid = Math.floor(minutes.length / 2);
    const median = minutes.length === 0 ? 0 : minutes.length % 2 ? minutes[mid]! : (minutes[mid - 1]! + minutes[mid]!) / 2;

    const longBuilds = this.events(from, to).filter((e) => (e.kind === 'build' || e.kind === 'test_run') && Number(e.detail.durationMs) > LONG_BUILD_MS);
    const brokenByBuild = blocks.filter((b) => longBuilds.some((e) => Math.abs(b.end - e.ts) <= BUILD_NEAR_MS)).length;

    return {
      focusMinutes: Math.round(minutes.reduce((a, b) => a + b, 0)),
      blocks: blocks.length,
      medianBlockMinutes: Math.round(median),
      longestBlocks: blocks.slice(0, 3),
      blocksEndedNearLongBuild: brokenByBuild,
    };
  }

  deleteDay(dayStart: number): void {
    const end = nextLocalDay(dayStart);
    this.openSpan = null;
    this.db.prepare('DELETE FROM state_spans WHERE start_ts >= ? AND start_ts < ?').run(dayStart, end);
    this.db.prepare('DELETE FROM dev_events WHERE ts >= ? AND ts < ?').run(dayStart, end);
  }

  deleteAll(): void {
    this.openSpan = null;
    this.db.exec('DELETE FROM state_spans; DELETE FROM dev_events; DELETE FROM watched_repos; VACUUM;');
  }

  prune(retentionDays: number, now: number): void {
    const cutoff = now - retentionDays * DAY;
    this.db.prepare('DELETE FROM state_spans WHERE end_ts < ?').run(cutoff);
    this.db.prepare('DELETE FROM dev_events WHERE ts < ?').run(cutoff);
  }

  repos(): { path: string; offset: number }[] {
    return (this.db.prepare('SELECT path, log_offset FROM watched_repos ORDER BY path').all() as { path: string; log_offset: number }[]).map((r) => ({ path: r.path, offset: r.log_offset }));
  }

  setRepo(path: string, offset: number): void {
    this.db.prepare('INSERT INTO watched_repos (path, log_offset) VALUES (?, ?) ON CONFLICT (path) DO UPDATE SET log_offset = excluded.log_offset').run(path, offset);
  }

  removeRepo(path: string): void {
    this.db.prepare('DELETE FROM watched_repos WHERE path = ?').run(path);
  }

  exportCsv(): string {
    const cell = (v: unknown) => {
      // A leading = + - @ would run as a formula in a spreadsheet.
      const s = String(v ?? '').replace(/^([=+\-@\t\r])/, "'$1");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = ['type,start,end,state_or_kind,source_or_repo,detail'];
    for (const s of this.spans(0, Number.MAX_SAFE_INTEGER)) {
      lines.push(['span', new Date(s.start).toISOString(), new Date(s.end).toISOString(), s.state, s.source, ''].map(cell).join(','));
    }
    for (const e of this.events(0, Number.MAX_SAFE_INTEGER)) {
      lines.push(['event', new Date(e.ts).toISOString(), '', e.kind, e.repo, JSON.stringify(e.detail)].map(cell).join(','));
    }
    return `${lines.join('\n')}\n`;
  }
}
