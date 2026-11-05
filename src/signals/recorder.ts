// Writes metrics to JSONL in the main process. Metrics only, never frames: the type has no
// way to carry image data, and sanitizeEvent drops anything that is not a known field.
import { appendFileSync, mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeEvent, serializeHeader } from './replay';
import type { RecordingHeader } from './types';

export class JsonlRecorder {
  private fd: number | null = null;
  readonly path: string;

  constructor(dir: string, header: Omit<RecordingHeader, 't' | 'version'>) {
    mkdirSync(dir, { recursive: true });
    const stamp = header.startedAt.replace(/[:.]/g, '-');
    this.path = join(dir, `live-${stamp}.jsonl`);
    this.fd = openSync(this.path, 'a', 0o600);
    appendFileSync(this.fd, `${serializeHeader({ t: 'header', version: 1, ...header })}\n`);
  }

  /** Returns false if the event was rejected. */
  append(event: unknown): boolean {
    if (this.fd === null) return false;
    const clean = sanitizeEvent(event);
    if (!clean) return false;
    appendFileSync(this.fd, `${JSON.stringify(clean)}\n`);
    return true;
  }

  close(): void {
    if (this.fd !== null) closeSync(this.fd);
    this.fd = null;
  }
}
