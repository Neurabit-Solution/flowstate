// Runs Pulse inside the app and writes where to reach it, readable only by this user.
import { randomBytes } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, Notification } from 'electron';
import { PulseCore, type HeldMessage } from '../mcp/core';
import { startPulseHttp, type DevEventSink, type PulseHttp } from '../mcp/http';
import type { PulseInfo } from '../shared/types';

export class PulseHost {
  readonly core: PulseCore;
  private http: PulseHttp | null = null;
  private token: string;
  private readonly file: string;

  constructor(
    dir: string,
    private readonly onChange: () => void,
    private readonly onDevEvent: DevEventSink,
    onQueued: (message: HeldMessage) => void,
  ) {
    this.file = join(dir, 'pulse.json');
    this.token = this.loadToken();
    this.core = new PulseCore({
      onDeliver: (messages) => this.deliver(messages),
      onQueued,
      onChange: () => {
        this.http?.notifyChanged();
        onChange();
      },
    });
  }

  private loadToken(): string {
    try {
      const saved = (JSON.parse(readFileSync(this.file, 'utf8')) as { token?: string }).token;
      if (saved) return saved;
    } catch {
      // First run.
    }
    return randomBytes(32).toString('hex');
  }

  async start(): Promise<void> {
    this.http = await startPulseHttp(this.core, this.token, app.getVersion(), this.onDevEvent);
    writeFileSync(this.file, JSON.stringify({ port: this.http.port, token: this.token }), { mode: 0o600 });
  }

  async stop(): Promise<void> {
    // The token stays, so existing HTTP configs keep working. The port does not.
    try {
      writeFileSync(this.file, JSON.stringify({ port: 0, token: this.token }), { mode: 0o600 });
    } catch {
      // Already deleted by Delete all data.
    }
    await this.http?.close();
    this.http = null;
  }

  private deliver(messages: HeldMessage[]): void {
    if (!Notification.isSupported()) return;
    const title = messages.length === 1 ? `Held message from ${messages[0]?.source}` : `${messages.length} held messages from your agents`;
    new Notification({ title, body: messages.map((m) => m.text).join('\n').slice(0, 500) }).show();
  }

  /** New token and no data. Agents need the setup command again. */
  async deleteAll(): Promise<void> {
    this.core.clear();
    await this.stop();
    rmSync(this.file, { force: true });
    this.token = randomBytes(32).toString('hex');
    await this.start();
  }

  cliCommand(): string {
    const script = join(app.getAppPath(), 'dist', 'cli', 'run.js');
    return `ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${script}" run -- npm test`;
  }

  info(): PulseInfo {
    const script = join(app.getAppPath(), 'dist', 'mcp', 'stdio.js');
    const command = process.execPath;
    const stdioEntry = { command, args: [script], env: { ELECTRON_RUN_AS_NODE: '1' } };
    return {
      running: this.http !== null,
      url: this.http ? `http://127.0.0.1:${this.http.port}/mcp` : null,
      claudeCommand: `claude mcp add flowstate -e ELECTRON_RUN_AS_NODE=1 -- "${command}" "${script}"`,
      cursorConfig: JSON.stringify({ mcpServers: { flowstate: stdioEntry } }, null, 2),
      copilotConfig: JSON.stringify({ mcpServers: { flowstate: { type: 'local', ...stdioEntry, tools: ['*'] } } }, null, 2),
      held: this.core.heldList.map((m) => ({ text: m.text, source: m.source, priority: m.priority, ts: m.ts })),
    };
  }
}
