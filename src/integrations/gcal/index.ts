import type { Fetch, Integration, StateStore, TestResult } from '../types';
import { refresh, type GoogleClient, type GoogleTokens } from './oauth';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary';
const SUMMARY = 'Focus time (FlowState)';
const BLOCK_MS = 30 * 60_000;
const EXTEND_WHEN_LEFT_MS = 10 * 60_000;
const MIN_EVENT_MS = 60_000;
const SAVED = 'gcal.event';

type SavedEvent = { id: string; start: number; end: number };

export type GcalDeps = {
  getClient: () => GoogleClient | null;
  getTokens: () => GoogleTokens | null;
  saveTokens: (tokens: GoogleTokens) => void;
  store: StateStore;
  http?: Fetch;
  now?: () => number;
};

export class GcalIntegration implements Integration {
  readonly id = 'gcal';
  readonly label = 'Google Calendar';
  private readonly http: Fetch;
  private readonly now: () => number;

  constructor(private readonly deps: GcalDeps) {
    this.http = deps.http ?? fetch;
    this.now = deps.now ?? Date.now;
  }

  ready(): boolean {
    return this.deps.getClient() !== null && this.deps.getTokens() !== null;
  }

  private async accessToken(): Promise<string> {
    const client = this.deps.getClient();
    let tokens = this.deps.getTokens();
    if (!client || !tokens) throw new Error('Google Calendar is not connected.');
    if (tokens.expiresAt - this.now() < 60_000) {
      tokens = await refresh(client, tokens, this.http, this.now);
      this.deps.saveTokens(tokens);
    }
    return tokens.accessToken;
  }

  private async call(method: string, path: string, body?: unknown): Promise<Record<string, unknown>> {
    const res = await this.http(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 204) return {};
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw Object.assign(new Error(`Google Calendar ${method}: ${res.status}`), { status: res.status });
    return json;
  }

  private iso(ms: number): { dateTime: string } {
    return { dateTime: new Date(ms).toISOString() };
  }

  async onEnterFocus(): Promise<void> {
    if (this.deps.store.get<SavedEvent>(SAVED)) return;
    const start = this.now();
    const end = start + BLOCK_MS;
    const event = await this.call('POST', '/events', {
      summary: SUMMARY,
      transparency: 'opaque',
      start: this.iso(start),
      end: this.iso(end),
      extendedProperties: { private: { flowstate: '1' } },
    });
    this.deps.store.set(SAVED, { id: String(event.id), start, end });
  }

  async onStillFocused(): Promise<void> {
    const saved = this.deps.store.get<SavedEvent>(SAVED);
    if (!saved || saved.end - this.now() > EXTEND_WHEN_LEFT_MS) return;
    const end = this.now() + BLOCK_MS;
    await this.call('PATCH', `/events/${encodeURIComponent(saved.id)}`, { end: this.iso(end) });
    this.deps.store.set(SAVED, { ...saved, end });
  }

  async onExitFocus(): Promise<void> {
    const saved = this.deps.store.get<SavedEvent>(SAVED);
    if (!saved) return;
    const path = `/events/${encodeURIComponent(saved.id)}`;
    const now = this.now();
    try {
      // After a crash the planned end may have passed. Never move it later than it was.
      const end = Math.min(now, saved.end);
      if (end - saved.start < MIN_EVENT_MS) await this.call('DELETE', path);
      else await this.call('PATCH', path, { end: this.iso(end) });
    } catch (err) {
      // The user deleted it from their calendar. That is fine.
      const status = (err as { status?: number }).status;
      if (status !== 404 && status !== 410) throw err;
    }
    this.deps.store.delete(SAVED);
  }

  async test(): Promise<TestResult> {
    try {
      await this.call('GET', '/events?maxResults=1');
      return { ok: true, detail: 'Connected to your primary calendar.' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
