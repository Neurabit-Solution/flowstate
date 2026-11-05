import type { Integration, RunCommand, StateStore, TestResult } from '../types';

const SAVED = 'os-focus.savedBanners';
const SCHEMA = 'org.gnome.desktop.notifications';
const KEY = 'show-banners';

/** GNOME keeps notifications from popping up. The previous value is saved and put back. */
export class GnomeFocus implements Integration {
  readonly id = 'os-focus';
  readonly label = 'GNOME Do Not Disturb';

  constructor(
    private readonly run: RunCommand,
    private readonly store: StateStore,
  ) {}

  ready(): boolean {
    return true;
  }

  async onEnterFocus(): Promise<void> {
    if (this.store.get<string>(SAVED) !== undefined) return;
    const current = (await this.run('gsettings', ['get', SCHEMA, KEY])).trim();
    this.store.set(SAVED, current);
    await this.run('gsettings', ['set', SCHEMA, KEY, 'false']);
  }

  async onExitFocus(): Promise<void> {
    const saved = this.store.get<string>(SAVED);
    if (saved === undefined) return;
    await this.run('gsettings', ['set', SCHEMA, KEY, saved === 'false' ? 'false' : 'true']);
    this.store.delete(SAVED);
  }

  async test(): Promise<TestResult> {
    try {
      const value = (await this.run('gsettings', ['get', SCHEMA, KEY])).trim();
      return { ok: true, detail: `Can read the setting. Notification banners are currently ${value === 'true' ? 'on' : 'off'}.` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** macOS has no public Focus API, so this runs two shortcuts the user creates once. */
export class MacFocus implements Integration {
  readonly id = 'os-focus';
  readonly label = 'macOS Focus';
  static readonly ON = 'FlowState On';
  static readonly OFF = 'FlowState Off';

  constructor(
    private readonly run: RunCommand,
    private readonly store: StateStore,
  ) {}

  ready(): boolean {
    return true;
  }

  async onEnterFocus(): Promise<void> {
    if (this.store.get<boolean>('os-focus.macOn')) return;
    await this.run('shortcuts', ['run', MacFocus.ON]);
    this.store.set('os-focus.macOn', true);
  }

  async onExitFocus(): Promise<void> {
    if (!this.store.get<boolean>('os-focus.macOn')) return;
    await this.run('shortcuts', ['run', MacFocus.OFF]);
    this.store.delete('os-focus.macOn');
  }

  async test(): Promise<TestResult> {
    try {
      const names = (await this.run('shortcuts', ['list'])).split('\n').map((n) => n.trim());
      const missing = [MacFocus.ON, MacFocus.OFF].filter((n) => !names.includes(n));
      if (missing.length > 0) return { ok: false, detail: `Create these shortcuts in the Shortcuts app: ${missing.join(', ')}.` };
      return { ok: true, detail: 'Both shortcuts are there.' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  }
}

/** For systems with no supported way to set this. It says so rather than pretending. */
export class ManualFocus implements Integration {
  readonly id = 'os-focus';

  constructor(
    readonly label: string,
    private readonly advice: string,
  ) {}

  ready(): boolean {
    return false;
  }

  async onEnterFocus(): Promise<void> {}
  async onExitFocus(): Promise<void> {}

  async test(): Promise<TestResult> {
    return { ok: false, detail: this.advice };
  }
}

export function createOsFocus(platform: NodeJS.Platform, desktop: string, run: RunCommand, store: StateStore): Integration {
  if (platform === 'darwin') return new MacFocus(run, store);
  if (platform === 'win32') {
    return new ManualFocus('Windows Focus Assist', 'Windows has no supported way for apps to turn this on. Turn on Do Not Disturb yourself from the notification area.');
  }
  if (platform === 'linux' && /gnome|unity|ubuntu/i.test(desktop)) return new GnomeFocus(run, store);
  return new ManualFocus('Desktop notifications', `FlowState cannot set Do Not Disturb on this desktop (${desktop || 'unknown'}) yet. Turn it on yourself.`);
}
