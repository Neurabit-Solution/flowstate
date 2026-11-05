// Everything downstream of signals/ sees only these types. No raw values, no scores.

export type DevState = 'off' | 'warming_up' | 'away' | 'talking' | 'available' | 'focused';

/** Yes/no answers from the signal module. null means no reading, so the state carries forward. */
export type Features = {
  /** Epoch milliseconds. */
  ts: number;
  present: boolean | null;
  talking: boolean | null;
  /** Above this user's own baseline. Never an absolute value. */
  steady: boolean | null;
};

export type Override = 'focus' | 'free' | 'paused';

export type DevStatus = { state: DevState; since: number; override: Override | null };

export type SensingSource = 'live' | 'replay' | null;

export type AppStatus = DevStatus & {
  source: SensingSource;
  cameraOn: boolean;
  sdkMinutesToday: number;
  heldMessages: number;
  overDailyCap: boolean;
  demo: boolean;
};

export type Settings = {
  onboarded: boolean;
  /** Off unless the user opts in. The SDK itself defaults this to on. */
  telemetry: boolean;
  sampleSeconds: number;
  everyMinutes: number;
  focusEnterMinutes: number;
  dailyCapMinutes: number;
  /** Browser device id of the chosen camera. null lets the SDK pick its default. */
  cameraId: string | null;
  /** Everything is off until the user turns it on. */
  enabledIntegrations: Record<string, boolean>;
};

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  telemetry: false,
  sampleSeconds: 60,
  everyMinutes: 5,
  focusEnterMinutes: 10,
  dailyCapMinutes: 120,
  cameraId: null,
  enabledIntegrations: {},
};

export type SensingCommand =
  | { type: 'start-sensing' }
  | { type: 'stop-sensing' }
  | { type: 'set-hold'; hold: boolean };

export type SaveKeyResult = { ok: true } | { ok: false; reason: string };

export type IntegrationView = { id: string; label: string; enabled: boolean; ready: boolean };
export type IntegrationTest = { ok: boolean; detail: string };
export type IntegrationLogEntry = { ts: number; integration: string; action: string; ok: boolean; error?: string };

export type PulseInfo = {
  running: boolean;
  url: string | null;
  claudeCommand: string;
  cursorConfig: string;
  copilotConfig: string;
  held: { text: string; source: string; priority: string; ts: number }[];
};

/** The typed API the preload exposes as window.flowstate. */
export type FlowstateBridge = {
  hasApiKey(): Promise<boolean>;
  getApiKey(): Promise<string | null>;
  saveApiKey(key: string): Promise<SaveKeyResult>;
  getSettings(): Promise<Settings>;
  updateSettings(patch: Partial<Settings>): Promise<Settings>;
  deleteLocalData(): Promise<void>;
  listRecordings(): Promise<string[]>;
  readRecording(name: string): Promise<string>;
  recorderStart(): Promise<string>;
  recorderAppend(event: unknown): void;
  recorderStop(): Promise<void>;
  sendFeatures(features: Features): void;
  reportSdkMs(ms: number): void;
  reportSensing(source: SensingSource, cameraOn: boolean): void;
  setOverride(override: Override | null, forMinutes?: number): void;
  getStatus(): Promise<AppStatus>;
  listIntegrations(): Promise<IntegrationView[]>;
  setIntegrationEnabled(id: string, enabled: boolean): Promise<void>;
  testIntegration(id: string): Promise<IntegrationTest>;
  saveSlackToken(token: string): Promise<SaveKeyResult>;
  connectGoogle(clientId: string, clientSecret: string): Promise<SaveKeyResult>;
  disconnectIntegration(id: string): Promise<void>;
  integrationLog(): Promise<IntegrationLogEntry[]>;
  pulseInfo(): Promise<PulseInfo>;
  onStatus(listener: (status: AppStatus) => void): () => void;
  onCommand(listener: (command: SensingCommand) => void): () => void;
};
