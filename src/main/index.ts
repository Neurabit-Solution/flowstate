import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, Notification, powerMonitor, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { AppStatus, Features, Override, SensingCommand, SensingSource, Settings } from '../shared/types';
import { listRecordings, readRecording, RecorderHost } from '../signals/main-ipc';
import type { SignalEvent } from '../signals/types';
import { DEFAULT_MACHINE_CONFIG, DevStateMachine, type MachineConfig } from '../state/machine';
import { isCameraRequestAllowed } from './permissions';
import { Store } from './store';
import { AppTray } from './tray';

const PAGE_PATH = join(__dirname, '../renderer/index.html');
const PAGE_URL = pathToFileURL(PAGE_PATH).href;
const PRELOAD_PATH = join(__dirname, '../preload/index.js');
const HEARTBEAT_MS = 5000;
const DEMO = process.argv.includes('--demo');

const NATIVE_LIB: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'libsmartspectra_capi.dylib',
  win32: 'smartspectra_capi.dll',
  linux: 'libsmartspectra_capi.so',
};

let win: BrowserWindow | null = null;
let tray: AppTray | null = null;
let store: Store;
let quitting = false;
let sdkLoadError: string | null = null;
let source: SensingSource = null;
let cameraOn = false;
let holdSent = false;
/** Set when we stopped the camera for a pause or a screen lock, and should bring it back. */
let resumeAfterPause = false;
let locked = false;

const machine = new DevStateMachine();

function machineConfig(s: Settings): MachineConfig {
  return { ...DEFAULT_MACHINE_CONFIG, focusEnterMs: (DEMO ? 0.5 : s.focusEnterMinutes) * 60_000 };
}

function status(): AppStatus {
  const sdkMinutesToday = store.sdkMinutesToday();
  return {
    ...machine.status(),
    source,
    cameraOn,
    sdkMinutesToday,
    overDailyCap: sdkMinutesToday >= store.settings.dailyCapMinutes,
    demo: DEMO,
  };
}

function broadcast(): void {
  const current = status();
  tray?.update(current);
  win?.webContents.send('flowstate:status', current);
  syncHold();
}

function send(command: SensingCommand): void {
  win?.webContents.send('flowstate:command', command);
}

function syncHold(): void {
  const hold = source === 'live' && machine.confirming;
  if (hold !== holdSent) {
    holdSent = hold;
    send({ type: 'set-hold', hold });
  }
}

/**
 * Loaded on demand because the native library path must be set first: requiring the SDK loads
 * it, and a library cannot be opened from inside app.asar. A failed load only disables the
 * camera, so sample recordings still work on unsupported machines such as Intel Macs.
 */
function bindSdk(target: BrowserWindow): void {
  const lib = NATIVE_LIB[process.platform];
  if (app.isPackaged && lib) {
    process.env.SMARTSPECTRA_CAPI_PATH = join(process.resourcesPath, 'smartspectra', lib);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');
    bindSmartSpectraIpc(target);
  } catch (err) {
    sdkLoadError = err instanceof Error ? err.message : String(err);
    console.error(`[flowstate] SmartSpectra SDK unavailable: ${sdkLoadError}`);
  }
}

function sdkVersion(): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@smartspectra/node-sdk/package.json').version as string;
  } catch {
    return null;
  }
}

function loadEnv(): void {
  if (app.isPackaged) return;
  try {
    process.loadEnvFile(join(app.getAppPath(), '.env'));
  } catch {
    // No .env. The keychain or sample recordings still work.
  }
}

function apiKey(): string | null {
  return store.loadApiKey() ?? (process.env.PRESAGE_API_KEY?.trim() || null);
}

const isOurPage = (event: IpcMainEvent | IpcMainInvokeEvent) => event.senderFrame?.url === PAGE_URL;

function handle<A extends unknown[], T>(channel: string, fn: (...args: A) => T): void {
  ipcMain.handle(channel, (event, ...args) => {
    if (!isOurPage(event)) throw new Error('Rejected');
    return fn(...(args as A));
  });
}

function listen<A extends unknown[]>(channel: string, fn: (...args: A) => void): void {
  ipcMain.on(channel, (event, ...args) => {
    if (isOurPage(event)) fn(...(args as A));
  });
}

function onSensing(next: SensingSource, camera: boolean): void {
  const changed = next !== source;
  source = next;
  cameraOn = camera;
  if (changed) {
    holdSent = false;
    // A screen lock keeps "away". Everything else that stops sensing means off.
    if (next === null && !locked) machine.stop(Date.now());
    if (next !== null) machine.start(Date.now());
  }
  broadcast();
}

function setOverride(override: Override | null, forMinutes?: number): void {
  const now = Date.now();
  const until = forMinutes ? now + forMinutes * 60_000 : null;
  const wasPaused = machine.status().override === 'paused';
  if (override === 'paused') {
    resumeAfterPause = source === 'live';
    send({ type: 'stop-sensing' });
  }
  machine.setOverride(override, now, until);
  // Ending a pause early brings the camera back, the same as letting it run out.
  if (wasPaused && override !== 'paused' && resumeAfterPause) {
    resumeAfterPause = false;
    send({ type: 'start-sensing' });
  }
  broadcast();
}

/** Manual "until tomorrow". No timer restarts the camera, so it can't come on overnight. */
function stopUntilClicked(): void {
  resumeAfterPause = false;
  send({ type: 'stop-sensing' });
}

function heartbeat(): void {
  // Replay runs on recording time, so wall-clock ticks would corrupt it.
  if (source === 'replay') return;
  const before = machine.status();
  machine.update({ ts: Date.now(), present: null, talking: null, steady: null });
  const after = machine.status();
  if (before.override === 'paused' && after.override === null && resumeAfterPause) {
    resumeAfterPause = false;
    send({ type: 'start-sensing' });
  }
  broadcast();
}

function watchPower(): void {
  const lock = () => {
    if (source !== 'live') return;
    locked = true;
    resumeAfterPause = true;
    machine.markAway(Date.now());
    send({ type: 'stop-sensing' });
    broadcast();
  };
  const unlock = () => {
    if (!locked) return;
    locked = false;
    if (resumeAfterPause) {
      resumeAfterPause = false;
      machine.stop(Date.now());
      send({ type: 'start-sensing' });
    }
  };
  powerMonitor.on('lock-screen', lock);
  powerMonitor.on('suspend', lock);
  powerMonitor.on('unlock-screen', unlock);
  powerMonitor.on('resume', () => {
    // Waking into a lock screen waits for the unlock.
    if (powerMonitor.getSystemIdleState(1) !== 'locked') unlock();
  });
}

function registerIpc(): void {
  const recordingsDir = join(app.getAppPath(), 'recordings');
  // Packaged apps cannot write inside app.asar.
  const liveDir = app.isPackaged ? join(app.getPath('userData'), 'recordings') : recordingsDir;
  const dirs = [liveDir, recordingsDir];
  const recorder = new RecorderHost(liveDir);

  handle('flowstate:has-api-key', () => apiKey() !== null && sdkLoadError === null);
  handle('flowstate:get-api-key', apiKey);
  handle('flowstate:save-api-key', (key: string) => store.saveApiKey(key));
  handle('flowstate:get-settings', () => store.settings);
  handle('flowstate:update-settings', (patch: Partial<Settings>) => {
    const next = store.updateSettings(patch);
    machine.setConfig(machineConfig(next));
    broadcast();
    return next;
  });
  handle('flowstate:delete-local-data', () => {
    send({ type: 'stop-sensing' });
    recorder.stop();
    for (const name of readdirSync(liveDir, { withFileTypes: true })) {
      if (name.isFile() && /^live-.*\.jsonl$/.test(name.name)) rmSync(join(liveDir, name.name));
    }
    store.deleteAll();
    machine.setConfig(machineConfig(store.settings));
    broadcast();
  });
  handle('flowstate:recordings-list', () => listRecordings(dirs));
  handle('flowstate:recordings-read', (name: string) => readRecording(dirs, name));
  handle('flowstate:recorder-start', () => recorder.start(sdkVersion()));
  handle('flowstate:recorder-stop', () => recorder.stop());
  handle('flowstate:get-status', status);
  listen('flowstate:recorder-append', (payload: SignalEvent) => recorder.append(payload));
  listen('flowstate:features', (features: Features) => {
    if (source === null) return;
    machine.update(features);
    broadcast();
  });
  listen('flowstate:sdk-ms', (ms: number) => {
    store.addSdkMs(ms);
    broadcast();
  });
  listen('flowstate:sensing', (next: SensingSource, camera: boolean) => onSensing(next, camera));
  listen('flowstate:set-override', (override: Override | null, forMinutes?: number) => setOverride(override, forMinutes));
  app.on('before-quit', () => recorder.stop());
}

function showWindow(): void {
  if (win) {
    win.show();
    win.focus();
  }
}

function createWindow(): void {
  const target = new BrowserWindow({
    width: 1000,
    height: 820,
    backgroundColor: '#101218',
    title: 'FlowState',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // The SDK and the sampling timers live here and must keep time while hidden.
      backgroundThrottling: false,
      additionalArguments: DEMO ? ['--flowstate-demo'] : [],
    },
  });
  win = target;
  bindSdk(target);
  // This window only ever shows our page, so remote content can never inherit the camera grant.
  target.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  target.webContents.on('will-navigate', (event) => event.preventDefault());
  target.on('close', (event) => {
    if (quitting) return;
    event.preventDefault();
    target.hide();
    // Some Linux desktops hide tray icons, so never let sensing continue without saying so.
    if (source === 'live' && Notification.isSupported()) {
      new Notification({ title: 'FlowState is still running', body: 'Sensing stays on in the tray. Use Stop camera there to turn it off.' }).show();
    }
  });
  target.on('closed', () => {
    win = null;
  });
  void target.loadFile(PAGE_PATH);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showWindow);
  app.on('before-quit', () => {
    quitting = true;
  });

  void app.whenReady().then(() => {
    loadEnv();
    store = new Store(app.getPath('userData'));
    machine.setConfig(machineConfig(store.settings));
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
      const media = details as { mediaTypes?: string[]; requestingUrl?: string };
      callback(
        isCameraRequestAllowed(
          { permission, mediaTypes: media.mediaTypes, requestingUrl: media.requestingUrl ?? wc?.getURL() ?? '' },
          PAGE_URL,
        ),
      );
    });
    registerIpc();
    createWindow();
    tray = new AppTray({
      startCamera: () => {
        // A tray click counts as consent only once the data screen has been seen.
        if (store.settings.onboarded) send({ type: 'start-sensing' });
        else showWindow();
      },
      stopCamera: () => {
        resumeAfterPause = false;
        send({ type: 'stop-sensing' });
      },
      setOverride,
      stopUntilClicked,
      openWindow: showWindow,
      quit: () => app.quit(),
    });
    tray.update(status());
    watchPower();
    setInterval(heartbeat, HEARTBEAT_MS);
    app.on('activate', showWindow);
  });
}
