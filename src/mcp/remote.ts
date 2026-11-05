// Used by the stdio bridge: forwards to the running app. If the app is not running, nobody is
// sensing, so it answers "off" and allows interruptions rather than blocking the agent.
import { readFileSync } from 'node:fs';
import type { DevStateView, FocusSummary, InterruptAnswer, Priority, PulseBackend, QueueAnswer, SummaryRange, WaitAnswer } from './core';

export type PulseConnection = { port: number; token: string };

export function readConnection(file: string): PulseConnection | null {
  try {
    const json = JSON.parse(readFileSync(file, 'utf8')) as Partial<PulseConnection>;
    return json.port && json.token ? { port: json.port, token: json.token } : null;
  } catch {
    return null;
  }
}

export class RemoteBackend implements PulseBackend {
  constructor(private readonly connectionFile: string) {}

  private async call<T>(method: string, args: Record<string, unknown>, fallback: T): Promise<T> {
    const connection = readConnection(this.connectionFile);
    if (!connection) return fallback;
    try {
      const res = await fetch(`http://127.0.0.1:${connection.port}/rpc/${method}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${connection.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
      return res.ok ? ((await res.json()) as T) : fallback;
    } catch {
      return fallback;
    }
  }

  getDevState(): Promise<DevStateView> {
    return this.call('getDevState', {}, { state: 'off', since: new Date(0).toISOString(), focusMinutesToday: 0, heldMessages: 0 });
  }

  shouldInterrupt(priority: Priority, reason: string): Promise<InterruptAnswer> {
    return this.call('shouldInterrupt', { priority, reason }, { allow: true, advice: 'FlowState is not running. Go ahead.' });
  }

  queueMessage(text: string, priority: Priority, source: string): Promise<QueueAnswer> {
    return this.call('queueMessage', { text, priority, source }, { queued: false, heldMessages: 0, advice: 'FlowState is not running, so nothing was held. Tell the user directly.' });
  }

  waitUntilAvailable(timeoutSeconds: number): Promise<WaitAnswer> {
    return this.call('waitUntilAvailable', { timeoutSeconds }, { available: true, state: 'off' });
  }

  getFocusSummary(range: SummaryRange): Promise<FocusSummary> {
    return this.call('getFocusSummary', { range }, { range, focusMinutes: 0, blocks: 0, longestBlockMinutes: 0 });
  }
}
