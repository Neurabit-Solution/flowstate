// Settings, daily SDK minutes and the encrypted API key, all under the app data dir.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import { apiKeyProblem } from './api-key';
import { DEFAULT_SETTINGS, type SaveKeyResult, type Settings } from '../shared/types';

type Saved = { settings: Settings; usage: { day: string; ms: number } };

const today = () => new Date().toLocaleDateString('en-CA');

export class Store {
  private readonly file: string;
  private readonly keyFile: string;
  private readonly secretsFile: string;
  private data: Saved;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, 'settings.json');
    this.keyFile = join(dir, 'presage-key.bin');
    this.secretsFile = join(dir, 'secrets.bin');
    this.data = this.load();
  }

  private load(): Saved {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<Saved>;
      return {
        settings: { ...DEFAULT_SETTINGS, ...raw.settings },
        usage: raw.usage ?? { day: today(), ms: 0 },
      };
    } catch {
      return { settings: { ...DEFAULT_SETTINGS }, usage: { day: today(), ms: 0 } };
    }
  }

  private save(): void {
    writeFileSync(this.file, JSON.stringify(this.data, null, 2), { mode: 0o600 });
  }

  get settings(): Settings {
    return this.data.settings;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    this.data.settings = { ...this.data.settings, ...patch };
    this.save();
    return this.data.settings;
  }

  addSdkMs(ms: number): void {
    this.rollDay();
    this.data.usage.ms += Math.max(0, ms);
    this.save();
  }

  sdkMinutesToday(): number {
    this.rollDay();
    return Math.round(this.data.usage.ms / 60_000);
  }

  private rollDay(): void {
    if (this.data.usage.day !== today()) this.data.usage = { day: today(), ms: 0 };
  }

  /** Refuses rather than falling back to plain text, which Linux can do with no keyring. */
  saveApiKey(key: string): SaveKeyResult {
    const trimmed = key.trim();
    const problem = apiKeyProblem(trimmed);
    if (problem) return { ok: false, reason: problem };
    if (!safeStorage.isEncryptionAvailable() || usesPlainTextBackend()) {
      return { ok: false, reason: 'No OS keychain is available, so the key was not saved. Set PRESAGE_API_KEY in .env instead.' };
    }
    writeFileSync(this.keyFile, safeStorage.encryptString(trimmed), { mode: 0o600 });
    return { ok: true };
  }

  loadApiKey(): string | null {
    if (!existsSync(this.keyFile)) return null;
    try {
      return safeStorage.decryptString(readFileSync(this.keyFile));
    } catch {
      return null;
    }
  }

  private readSecrets(): Record<string, unknown> {
    if (!existsSync(this.secretsFile)) return {};
    try {
      return JSON.parse(safeStorage.decryptString(readFileSync(this.secretsFile))) as Record<string, unknown>;
    } catch {
      return {};
    }
  }

  getSecret<T>(name: string): T | undefined {
    return this.readSecrets()[name] as T | undefined;
  }

  /** Same rule as the API key: refuse rather than store a token as plain text. */
  setSecret(name: string, value: unknown): SaveKeyResult {
    if (!safeStorage.isEncryptionAvailable() || usesPlainTextBackend()) {
      return { ok: false, reason: 'No OS keychain is available, so this was not saved.' };
    }
    const all = { ...this.readSecrets(), [name]: value };
    writeFileSync(this.secretsFile, safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 });
    return { ok: true };
  }

  deleteSecret(name: string): void {
    const all = this.readSecrets();
    if (!(name in all)) return;
    delete all[name];
    writeFileSync(this.secretsFile, safeStorage.encryptString(JSON.stringify(all)), { mode: 0o600 });
  }

  deleteAll(): void {
    rmSync(this.keyFile, { force: true });
    rmSync(this.secretsFile, { force: true });
    rmSync(this.file, { force: true });
    this.data = { settings: { ...DEFAULT_SETTINGS }, usage: { day: today(), ms: 0 } };
  }
}

function usesPlainTextBackend(): boolean {
  return process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
}
