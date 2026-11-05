import type { Fetch, Integration, StateStore, TestResult } from '../types';

// Only the user's own status and Do Not Disturb. This file must never post to a channel.
const API = 'https://slack.com/api/';
const SNOOZE_MINUTES = 60;
const STATUS_TEXT = 'Focusing (FlowState)';
const STATUS_EMOJI = ':no_bell:';
const SAVED = 'slack.savedStatus';

type SavedStatus = { text: string; emoji: string; expiration: number };

export class SlackIntegration implements Integration {
  readonly id = 'slack';
  readonly label = 'Slack';

  constructor(
    private readonly getToken: () => string | null,
    private readonly store: StateStore,
    private readonly http: Fetch = fetch,
  ) {}

  ready(): boolean {
    return this.getToken() !== null;
  }

  private async call(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const token = this.getToken();
    if (!token) throw new Error('Slack is not connected.');
    const res = await this.http(`${API}${method}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!json.ok) throw new Error(`Slack ${method}: ${String(json.error ?? res.status)}`);
    return json;
  }

  private async currentStatus(): Promise<SavedStatus> {
    const json = await this.call('users.profile.get', {});
    const profile = (json.profile ?? {}) as Record<string, unknown>;
    return {
      text: String(profile.status_text ?? ''),
      emoji: String(profile.status_emoji ?? ''),
      expiration: Number(profile.status_expiration ?? 0),
    };
  }

  private setStatus(status: SavedStatus): Promise<unknown> {
    return this.call('users.profile.set', {
      profile: { status_text: status.text, status_emoji: status.emoji, status_expiration: status.expiration },
    });
  }

  async onEnterFocus(): Promise<void> {
    if (this.store.get<SavedStatus>(SAVED) === undefined) {
      const current = await this.currentStatus();
      // Saved before changing anything, so a crash in between can still be undone.
      this.store.set(SAVED, current);
    }
    await this.call('dnd.setSnooze', { num_minutes: SNOOZE_MINUTES });
    await this.setStatus({ text: STATUS_TEXT, emoji: STATUS_EMOJI, expiration: 0 });
  }

  /** The snooze runs out by itself, which also limits the damage if the app dies. */
  async onStillFocused(): Promise<void> {
    await this.call('dnd.setSnooze', { num_minutes: SNOOZE_MINUTES });
  }

  async onExitFocus(): Promise<void> {
    const saved = this.store.get<SavedStatus>(SAVED);
    if (saved === undefined) return;
    try {
      await this.call('dnd.endSnooze', {});
    } catch (err) {
      // Already ended, for example because it ran out.
      if (!(err instanceof Error && err.message.includes('snooze_not_active'))) throw err;
    }
    // If the user set their own status during focus, leave it alone.
    const current = await this.currentStatus();
    if (current.text === STATUS_TEXT) await this.setStatus(saved);
    this.store.delete(SAVED);
  }

  async test(): Promise<TestResult> {
    try {
      const json = await this.call('auth.test', {});
      return { ok: true, detail: `Connected to ${String(json.team)} as ${String(json.user)}.` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}
