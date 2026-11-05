// Main-process side of the signal module: SDK IPC binding, the recorder, and recordings on disk.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { JsonlRecorder } from './recorder';
import type { SignalEvent } from './types';

const RECORDING_NAME = /^[\w.-]+\.jsonl$/;

export function listRecordings(dirs: string[]): string[] {
  const names = new Set<string>();
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) if (RECORDING_NAME.test(name)) names.add(name);
  }
  return [...names].sort();
}

/** The renderer names a file, never a path. */
export function readRecording(dirs: string[], name: string): string {
  if (!RECORDING_NAME.test(name) || basename(name) !== name) throw new Error('Invalid recording name');
  for (const dir of dirs) {
    const path = join(dir, name);
    if (existsSync(path)) return readFileSync(path, 'utf8');
  }
  throw new Error('Recording not found');
}

export class RecorderHost {
  private recorder: JsonlRecorder | null = null;

  constructor(private readonly dir: string) {}

  start(sdkVersion: string | null): string {
    this.stop();
    this.recorder = new JsonlRecorder(this.dir, {
      origin: 'live',
      startedAt: new Date().toISOString(),
      sdkVersion,
    });
    return this.recorder.path;
  }

  append(event: SignalEvent): void {
    this.recorder?.append(event);
  }

  stop(): void {
    this.recorder?.close();
    this.recorder = null;
  }
}
