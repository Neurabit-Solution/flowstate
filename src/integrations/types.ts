// Integrations only ever learn "focus started" and "focus ended". They never import signals/.

export type TestResult = { ok: boolean; detail: string };

export interface Integration {
  readonly id: string;
  readonly label: string;
  /** False when this integration has nothing to act on, such as Slack with no token. */
  ready(): boolean;
  /** Must be safe to call twice. */
  onEnterFocus(): Promise<void>;
  /** Must be safe to call twice, and must put back what was there before. */
  onExitFocus(): Promise<void>;
  /** Called every few minutes during focus, to extend anything that would run out. */
  onStillFocused?(): Promise<void>;
  test(): Promise<TestResult>;
}

/** Small persistent store, so a crash during focus can still be undone at next launch. */
export interface StateStore {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}

export type RunCommand = (file: string, args: string[]) => Promise<string>;
export type Fetch = typeof fetch;

export type LogEntry = { ts: number; integration: string; action: string; ok: boolean; error?: string };

export type IntegrationInfo = {
  id: string;
  label: string;
  enabled: boolean;
  ready: boolean;
};
