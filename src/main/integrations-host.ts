// Connects the integrations to the app: their saved state, secrets and IPC.
import { execFile } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { shell } from 'electron';
import { GcalIntegration } from '../integrations/gcal';
import { signIn, type GoogleClient, type GoogleTokens } from '../integrations/gcal/oauth';
import { IntegrationManager } from '../integrations/manager';
import { createOsFocus } from '../integrations/os-focus';
import { SlackIntegration } from '../integrations/slack';
import type { Integration, IntegrationInfo, RunCommand, StateStore, TestResult } from '../integrations/types';
import type { SaveKeyResult } from '../shared/types';
import type { Store } from './store';

const exec = promisify(execFile);
const run: RunCommand = async (file, args) => (await exec(file, args, { timeout: 10_000 })).stdout;

const SLACK_TOKEN = 'slack.token';
const GOOGLE_CLIENT = 'google.client';
const GOOGLE_TOKENS = 'google.tokens';

class JsonStateStore implements StateStore {
  private data: Record<string, unknown> = {};

  constructor(private readonly file: string) {
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    } catch {
      // First run.
    }
  }

  get<T>(key: string): T | undefined {
    return this.data[key] as T | undefined;
  }

  set(key: string, value: unknown): void {
    this.data[key] = value;
    this.flush();
  }

  delete(key: string): void {
    delete this.data[key];
    this.flush();
  }

  private flush(): void {
    writeFileSync(this.file, JSON.stringify(this.data), { mode: 0o600 });
  }

  clear(): void {
    this.data = {};
    rmSync(this.file, { force: true });
  }
}

export class IntegrationsHost {
  readonly manager: IntegrationManager;
  private readonly state: JsonStateStore;
  private readonly list: Integration[];

  constructor(
    dir: string,
    private readonly store: Store,
    private readonly onChange: () => void,
  ) {
    this.state = new JsonStateStore(join(dir, 'integration-state.json'));
    this.list = [
      createOsFocus(process.platform, process.env.XDG_CURRENT_DESKTOP ?? '', run, this.state),
      new SlackIntegration(() => store.getSecret<string>(SLACK_TOKEN) ?? null, this.state),
      new GcalIntegration({
        getClient: () => store.getSecret<GoogleClient>(GOOGLE_CLIENT) ?? null,
        getTokens: () => store.getSecret<GoogleTokens>(GOOGLE_TOKENS) ?? null,
        saveTokens: (tokens) => void store.setSecret(GOOGLE_TOKENS, tokens),
        store: this.state,
      }),
    ];
    this.manager = new IntegrationManager({
      integrations: this.list,
      store: this.state,
      isEnabled: (id) => store.settings.enabledIntegrations[id] === true,
      onLog: () => onChange(),
    });
  }

  info(): IntegrationInfo[] {
    return this.list.map((i) => ({ id: i.id, label: i.label, ready: i.ready(), enabled: this.store.settings.enabledIntegrations[i.id] === true }));
  }

  setEnabled(id: string, enabled: boolean): void {
    this.store.updateSettings({ enabledIntegrations: { ...this.store.settings.enabledIntegrations, [id]: enabled } });
    this.onChange();
  }

  async test(id: string): Promise<TestResult> {
    const integration = this.list.find((i) => i.id === id);
    if (!integration) return { ok: false, detail: 'Unknown integration.' };
    return integration.test();
  }

  /** A user token from the user's own Slack app. See docs/INTEGRATIONS.md. */
  saveSlackToken(token: string): SaveKeyResult {
    const trimmed = token.trim();
    // A bot token cannot change a person's status or Do Not Disturb.
    if (!trimmed.startsWith('xoxp-')) return { ok: false, reason: 'That is not a Slack user token. It should start with xoxp-.' };
    const result = this.store.setSecret(SLACK_TOKEN, trimmed);
    this.onChange();
    return result;
  }

  async connectGoogle(clientId: string, clientSecret: string): Promise<SaveKeyResult> {
    const client = { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
    if (!client.clientId || !client.clientSecret) return { ok: false, reason: 'Both the client ID and client secret are needed.' };
    try {
      const tokens = await signIn(client, (url) => void shell.openExternal(url));
      const saved = this.store.setSecret(GOOGLE_CLIENT, client);
      if (!saved.ok) return saved;
      const result = this.store.setSecret(GOOGLE_TOKENS, tokens);
      this.onChange();
      return result;
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Undoes anything still in place first, while the tokens to do it still exist. */
  async disconnect(id: string): Promise<void> {
    await this.list.find((i) => i.id === id)?.onExitFocus().catch(() => undefined);
    if (id === 'slack') this.store.deleteSecret(SLACK_TOKEN);
    if (id === 'gcal') {
      this.store.deleteSecret(GOOGLE_CLIENT);
      this.store.deleteSecret(GOOGLE_TOKENS);
    }
    this.setEnabled(id, false);
  }

  async deleteAll(): Promise<void> {
    await this.manager.shutdown();
    this.state.clear();
  }
}
