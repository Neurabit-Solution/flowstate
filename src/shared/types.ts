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
};

export const DEFAULT_SETTINGS: Settings = {
  onboarded: false,
  telemetry: false,
  sampleSeconds: 60,
  everyMinutes: 5,
  focusEnterMinutes: 10,
  dailyCapMinutes: 120,
  cameraId: null,
};

export type SensingCommand =
  | { type: 'start-sensing' }
  | { type: 'stop-sensing' }
  | { type: 'set-hold'; hold: boolean };

export type SaveKeyResult = { ok: true } | { ok: false; reason: string };

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
  onStatus(listener: (status: AppStatus) => void): () => void;
  onCommand(listener: (command: SensingCommand) => void): () => void;
};
