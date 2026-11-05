import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PulseCore } from '../src/mcp/core';
import { startPulseHttp } from '../src/mcp/http';
import { GitWatcher, parseReflogLine } from '../src/timeline/git';
import { startOfLocalDay, TimelineStore } from '../src/timeline/store';

const MIN = 60_000;
const DAY = new Date(2026, 10, 10, 0, 0, 0).getTime();
const at = (h: number, m = 0) => DAY + (h * 60 + m) * MIN;

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'timeline-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
const fresh = () => new TimelineStore(join(dir, `t${n++}.db`));

describe('state spans', () => {
  it('merges updates, starts a row on change, and skips off and warming up', () => {
    const t = fresh();
    t.recordState('warming_up', 'live', at(9));
    t.recordState('available', 'live', at(9, 1));
    t.recordState('available', 'live', at(9, 5));
    t.recordState('focused', 'live', at(9, 10));
    t.recordState('focused', 'live', at(10));
    t.recordState('off', 'live', at(10, 30));
    expect(t.spans(DAY, DAY + 24 * 60 * MIN)).toEqual([
      { state: 'available', start: at(9, 1), end: at(9, 10), source: 'live' },
      { state: 'focused', start: at(9, 10), end: at(10, 30), source: 'live' },
    ]);
  });

  it('keeps what it had if the app dies without closing a span', () => {
    const path = join(dir, 'crash.db');
    const a = new TimelineStore(path);
    a.recordState('focused', 'live', at(9));
    a.recordState('focused', 'live', at(9, 30));
    a.close();
    const b = new TimelineStore(path);
    b.recordState('available', 'live', at(11));
    expect(b.spans(DAY, at(23)).map((s) => [s.state, s.end])).toEqual([
      ['focused', at(9, 30)],
      ['available', at(11)],
    ]);
  });

  it('a change of source starts a new span', () => {
    const t = fresh();
    t.recordState('focused', 'live', at(9));
    t.recordState('focused', 'manual', at(9, 30));
    t.recordState('off', 'manual', at(10));
    expect(t.spans(DAY, at(23)).map((s) => s.source)).toEqual(['live', 'manual']);
  });

  it('has no column that could hold a raw signal', () => {
    const t = fresh();
    t.recordState('focused', 'live', at(9));
    const csv = t.exportCsv();
    expect(csv.split('\n')[0]).toBe('type,start,end,state_or_kind,source_or_repo,detail');
    expect(readFileSync('src/timeline/store.ts', 'utf8')).not.toMatch(/signals\/|upperTrace|breathing|pulseRate/);
  });
});

describe('patterns', () => {
  function withBlocks() {
    const t = fresh();
    for (const [start, end] of [
      [at(9), at(9, 40)],
      [at(10), at(11, 30)],
      [at(14), at(14, 20)],
    ] as const) {
      t.recordState('focused', 'live', start);
      t.recordState('available', 'live', end);
    }
    t.recordState('off', 'live', at(15));
    return t;
  }

  it('reports minutes, median and longest', () => {
    const insights = withBlocks().insights(DAY, at(23));
    expect(insights).toMatchObject({ focusMinutes: 150, blocks: 3, medianBlockMinutes: 40, blocksEndedNearLongBuild: 0 });
    expect(insights.longestBlocks[0]).toEqual({ start: at(10), end: at(11, 30) });
  });

  it('counts focus that ended near a long build, not a short one', () => {
    const t = withBlocks();
    t.addEvent(at(9, 39), 'build', 'r', { durationMs: 6 * MIN });
    t.addEvent(at(14, 19), 'build', 'r', { durationMs: MIN });
    t.addEvent(at(11, 0), 'test_run', 'r', { durationMs: 10 * MIN });
    expect(t.insights(DAY, at(23)).blocksEndedNearLongBuild).toBe(1);
  });

  it('never counts samples', () => {
    const t = fresh();
    t.recordState('focused', 'replay', at(9));
    t.recordState('off', 'replay', at(11));
    expect(t.insights(DAY, at(23)).blocks).toBe(0);
    expect(t.weekHeatmap(DAY, at(23)).flat().reduce((a, b) => a + b, 0)).toBe(0);
    expect(t.spans(DAY, at(23)).length).toBe(1);
  });

  it('splits the heatmap across hours', () => {
    const t = fresh();
    t.recordState('focused', 'live', at(9, 30));
    t.recordState('off', 'live', at(11, 15));
    const row = t.weekHeatmap(DAY, at(23))[new Date(DAY).getDay()]!;
    expect([row[9], row[10], row[11], row[12]]).toEqual([30, 60, 15, 0]);
  });
});

describe('retention, delete and export', () => {
  it('prunes old rows and keeps recent ones', () => {
    const t = fresh();
    t.recordState('focused', 'live', at(9));
    t.recordState('off', 'live', at(10));
    t.addEvent(at(9), 'commit', 'r', {});
    t.prune(30, at(9) + 29 * 24 * 60 * MIN);
    expect(t.spans(0, Number.MAX_SAFE_INTEGER).length).toBe(1);
    t.prune(30, at(10) + 31 * 24 * 60 * MIN);
    expect(t.spans(0, Number.MAX_SAFE_INTEGER).length).toBe(0);
    expect(t.events(0, Number.MAX_SAFE_INTEGER).length).toBe(0);
  });

  it('deletes one day only', () => {
    const t = fresh();
    const tomorrow = at(9) + 24 * 60 * MIN;
    t.recordState('focused', 'live', at(9));
    t.recordState('off', 'live', at(10));
    t.recordState('focused', 'live', tomorrow);
    t.recordState('off', 'live', tomorrow + MIN);
    t.deleteDay(startOfLocalDay(at(9)));
    expect(t.spans(0, Number.MAX_SAFE_INTEGER).map((s) => s.start)).toEqual([tomorrow]);
  });

  it('delete all really removes it from the file', () => {
    const path = join(dir, 'wipe.db');
    const t = new TimelineStore(path);
    t.addEvent(at(9), 'commit', 'secret-project-name', { message: 'a very identifiable commit message' });
    t.recordState('focused', 'live', at(9));
    t.setRepo('/somewhere', 0);
    t.deleteAll();
    expect(t.spans(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(t.events(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    expect(t.repos()).toEqual([]);
    t.close();
    expect(readFileSync(path).includes('identifiable')).toBe(false);
  });

  it('exports CSV that cannot run as a spreadsheet formula', () => {
    const t = fresh();
    t.addEvent(at(9), 'commit', '=HYPERLINK("http://x")', { message: 'has, comma "and quote"' });
    const csv = t.exportCsv();
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});

describe('git watcher', () => {
  it('parses commit and checkout lines, and ignores the rest', () => {
    const head = 'a'.repeat(40);
    const prefix = `${'0'.repeat(40)} ${head} Sam Dev <s@example.com> 1800000000 +0530\t`;
    expect(parseReflogLine(`${prefix}commit: fix the thing`)).toEqual({ ts: 1_800_000_000_000, kind: 'commit', detail: { hash: head, message: 'fix the thing' } });
    expect(parseReflogLine(`${prefix}commit (amend): fix again`)?.kind).toBe('commit');
    expect(parseReflogLine(`${prefix}commit (initial): first`)?.kind).toBe('commit');
    expect(parseReflogLine(`${prefix}checkout: moving from main to feature/x`)?.detail).toEqual({ from: 'main', to: 'feature/x' });
    expect(parseReflogLine(`${prefix}pull: Fast-forward`)).toBeNull();
    expect(parseReflogLine('garbage')).toBeNull();
  });

  it('sees new work in a real repo, without older history', async () => {
    const repo = join(dir, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: repo, stdio: 'pipe' });
    git('init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a'), '1');
    git('add', '.');
    git('commit', '-qm', 'older work');

    const t = fresh();
    const watcher = new GitWatcher(t, async () => 2);
    expect(watcher.add(repo)).toBeNull();
    await watcher.poll();
    expect(t.events(0, Number.MAX_SAFE_INTEGER)).toEqual([]);

    writeFileSync(join(repo, 'a'), '2');
    git('add', '.');
    git('commit', '-qm', 'new work');
    git('checkout', '-qb', 'feature');
    await watcher.poll();
    await watcher.poll();
    const events = t.events(0, Number.MAX_SAFE_INTEGER);
    expect(events.map((e) => e.kind)).toEqual(['commit', 'branch_switch']);
    expect(events[0]).toMatchObject({ repo: 'repo', detail: { message: 'new work', filesChanged: 2 } });
  });

  it('waits for a half-written line and survives a rewritten log', async () => {
    const repo = join(dir, 'fake');
    const logs = join(repo, '.git', 'logs');
    mkdirSync(logs, { recursive: true });
    const log = join(logs, 'HEAD');
    writeFileSync(log, '');
    const t = fresh();
    const watcher = new GitWatcher(t, async () => null);
    watcher.add(repo);
    const line = `${'0'.repeat(40)} ${'a'.repeat(40)} T <t@e> 1800000000 +0000\tcommit: hello`;
    appendFileSync(log, line.slice(0, 50));
    await watcher.poll();
    expect(t.events(0, Number.MAX_SAFE_INTEGER)).toEqual([]);
    appendFileSync(log, `${line.slice(50)}\n`);
    await watcher.poll();
    expect(t.events(0, Number.MAX_SAFE_INTEGER).length).toBe(1);
    writeFileSync(log, '');
    await watcher.poll();
    appendFileSync(log, `${line}\n`);
    await watcher.poll();
    expect(t.events(0, Number.MAX_SAFE_INTEGER).length).toBe(2);
  });

  it('refuses a folder that is not a repo', () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    expect(new GitWatcher(fresh(), async () => null).add(plain)).toMatch(/not a git/);
  });
});

describe('flowstate run', () => {
  let script: string;
  beforeAll(async () => {
    script = join(dir, 'run.js');
    await build({ entryPoints: ['src/cli/run.ts'], outfile: script, bundle: true, platform: 'node', format: 'cjs', target: 'node20', logLevel: 'silent' });
  });
  const flowstate = (env: Record<string, string>, ...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });

  it('keeps output and exit code, and works with the app closed', () => {
    const r = flowstate({ FLOWSTATE_PULSE_FILE: join(dir, 'missing.json') }, 'run', '--', process.execPath, '-e', "console.log('hello'); process.exit(3)");
    expect(r.status).toBe(3);
    expect(r.stdout).toBe('hello\n');
  });

  it('reports a command that does not exist', () => {
    const r = flowstate({ FLOWSTATE_PULSE_FILE: join(dir, 'missing.json') }, 'run', '--', 'no-such-command-here');
    expect(r.status).toBe(127);
  });

  it('shows usage for anything else', () => {
    expect(flowstate({}, 'nonsense').status).toBe(2);
  });

  it('records the run, with only the first two words of the command', async () => {
    const events: { kind: string; detail: Record<string, unknown>; repo: string | null }[] = [];
    const http = await startPulseHttp(new PulseCore(), 'cli-token', '0', (e) => events.push(e));
    const file = join(dir, 'pulse-cli.json');
    writeFileSync(file, JSON.stringify({ port: http.port, token: 'cli-token' }));
    try {
      const { spawn } = await import('node:child_process');
      const child = spawn(process.execPath, [script, 'run', '--kind', 'test_run', '--', process.execPath, '-e', 'process.exit(0)', 'SECRET=hunter2'], {
        env: { PATH: process.env.PATH ?? '', FLOWSTATE_PULSE_FILE: file },
        stdio: 'ignore',
      });
      await new Promise((resolve) => child.on('close', resolve));
      expect(events.length).toBe(1);
      expect(events[0]).toMatchObject({ kind: 'test_run', detail: { exitCode: 0 } });
      expect(JSON.stringify(events[0])).not.toContain('hunter2');
    } finally {
      await http.close();
    }
  });
});

describe('rules', () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = join(d, f);
      return statSync(p).isDirectory() ? walk(p) : [p];
    });
  it('the timeline and CLI import nothing from the signal module', () => {
    for (const file of [...walk('src/timeline'), ...walk('src/cli')]) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/signals\/|@smartspectra/);
    }
  });
});
