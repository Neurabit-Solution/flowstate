// Reads commits and branch switches from .git/logs/HEAD. Starts at the end of the file, so
// history from before you added the repo stays out.
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { DevEventKind } from '../shared/types';
import type { TimelineStore } from './store';

export type ParsedEntry = { ts: number; kind: DevEventKind; detail: Record<string, unknown> };

const LINE = /^(\S+) (\S+) .*? (\d+) [+-]\d{4}\t(.*)$/;

export function parseReflogLine(line: string): ParsedEntry | null {
  const match = LINE.exec(line);
  if (!match) return null;
  const [, , hash, seconds, action] = match as unknown as [string, string, string, string, string];
  const ts = Number(seconds) * 1000;
  const commit = /^commit(?: \([^)]*\))?: (.*)$/.exec(action);
  if (commit) return { ts, kind: 'commit', detail: { hash, message: (commit[1] ?? '').slice(0, 200) } };
  const checkout = /^checkout: moving from (\S+) to (\S+)$/.exec(action);
  if (checkout) return { ts, kind: 'branch_switch', detail: { from: checkout[1], to: checkout[2] } };
  return null;
}

/** A worktree's .git is a file that points at the real directory. */
export function reflogPath(repo: string): string | null {
  const dotGit = join(repo, '.git');
  if (!existsSync(dotGit)) return null;
  if (statSync(dotGit).isDirectory()) return join(dotGit, 'logs', 'HEAD');
  const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!match?.[1]) return null;
  const dir = match[1].trim();
  return join(isAbsolute(dir) ? dir : resolve(repo, dir), 'logs', 'HEAD');
}

export class GitWatcher {
  constructor(
    private readonly store: TimelineStore,
    private readonly countFiles: (repo: string, hash: string) => Promise<number | null>,
  ) {}

  /** Returns an error message, or null when added. */
  add(repo: string): string | null {
    const log = reflogPath(repo);
    if (!log) return 'That folder is not a git repository.';
    this.store.setRepo(repo, existsSync(log) ? statSync(log).size : 0);
    return null;
  }

  async poll(): Promise<void> {
    for (const { path, offset } of this.store.repos()) await this.pollRepo(path, offset);
  }

  private async pollRepo(repo: string, offset: number): Promise<void> {
    const log = reflogPath(repo);
    if (!log || !existsSync(log)) return;
    const size = statSync(log).size;
    // Rewritten by git gc or a reflog expire. Skip to the end, not back through old history.
    if (size < offset) {
      this.store.setRepo(repo, size);
      return;
    }
    if (size === offset) return;
    const fd = openSync(log, 'r');
    let text: string;
    try {
      const buf = Buffer.alloc(size - offset);
      readSync(fd, buf, 0, buf.length, offset);
      text = buf.toString('utf8');
    } finally {
      closeSync(fd);
    }
    // A half-written last line waits for the next poll.
    const complete = text.lastIndexOf('\n') + 1;
    for (const line of text.slice(0, complete).split('\n')) {
      const entry = parseReflogLine(line);
      if (!entry) continue;
      const detail = { ...entry.detail };
      if (entry.kind === 'commit') detail.filesChanged = await this.countFiles(repo, String(detail.hash));
      this.store.addEvent(entry.ts, entry.kind, basename(repo), detail);
    }
    this.store.setRepo(repo, offset + Buffer.byteLength(text.slice(0, complete)));
  }
}
