#!/usr/bin/env node
// flowstate run -- npm test
// Runs the command as normal and records when it ran and how it ended. Its output, input and
// exit code pass straight through. If FlowState is not running, the command still runs.
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { readConnection } from '../mcp/remote';

function connectionFile(): string {
  if (process.env.FLOWSTATE_PULSE_FILE) return process.env.FLOWSTATE_PULSE_FILE;
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'flowstate', 'pulse.json');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'flowstate', 'pulse.json');
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'flowstate', 'pulse.json');
}

async function record(body: Record<string, unknown>): Promise<void> {
  const connection = readConnection(connectionFile());
  if (!connection) return;
  try {
    await fetch(`http://127.0.0.1:${connection.port}/rpc/addDevEvent`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // Recording is never worth failing someone's build over.
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const split = args.indexOf('--');
  if (args[0] !== 'run' || split === -1 || split === args.length - 1) {
    console.error('Usage: flowstate run [--kind test_run|build] -- <command> [args...]');
    process.exit(2);
  }
  const kindAt = args.indexOf('--kind');
  const command = args.slice(split + 1);
  const words = command.join(' ');
  const kind = kindAt !== -1 && kindAt < split ? args[kindAt + 1] : /\b(test|vitest|jest|pytest|spec)\b/.test(words) ? 'test_run' : 'build';

  const started = Date.now();
  const child = spawn(command[0]!, command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => child.kill(signal));
  const code = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      console.error(`flowstate: ${err.message}`);
      resolve(127);
    });
    child.on('close', (exit, signal) => resolve(exit ?? (signal ? 1 : 0)));
  });
  await record({
    ts: started,
    kind,
    repo: basename(process.cwd()),
    // Just the first two words. Later arguments could hold a password or a token.
    detail: { command: command.slice(0, 2).join(' ').slice(0, 100), exitCode: code, durationMs: Date.now() - started },
  });
  process.exit(code);
}

void main();
