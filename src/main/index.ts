import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, session, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { listRecordings, readRecording, RecorderHost } from '../signals/main-ipc';
import type { SignalEvent } from '../signals/types';
import { isCameraRequestAllowed } from './permissions';

const PAGE_PATH = join(__dirname, '../renderer/index.html');
const PAGE_URL = pathToFileURL(PAGE_PATH).href;
const PRELOAD_PATH = join(__dirname, '../preload/index.js');

const NATIVE_LIB: Partial<Record<NodeJS.Platform, string>> = {
  darwin: 'libsmartspectra_capi.dylib',
  win32: 'smartspectra_capi.dll',
  linux: 'libsmartspectra_capi.so',
};

let sdkLoadError: string | null = null;

/**
 * Loaded on demand because the native library path must be set first: requiring the SDK loads
 * it, and a library cannot be opened from inside app.asar. A failed load only disables the
 * camera, so sample recordings still work on unsupported machines such as Intel Macs.
 */
function bindSdk(win: BrowserWindow): void {
  const lib = NATIVE_LIB[process.platform];
  if (app.isPackaged && lib) {
    process.env.SMARTSPECTRA_CAPI_PATH = join(process.resourcesPath, 'smartspectra', lib);
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { bindSmartSpectraIpc } = require('@smartspectra/node-sdk/main');
    bindSmartSpectraIpc(win);
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
    // No .env yet. Sample recordings still work.
  }
}

function apiKey(): string | null {
  return process.env.PRESAGE_API_KEY?.trim() || null;
}

const isOurPage = (event: IpcMainEvent | IpcMainInvokeEvent) => event.senderFrame?.url === PAGE_URL;

function handle<T>(channel: string, fn: () => T): void {
  ipcMain.handle(channel, (event) => {
    if (!isOurPage(event)) throw new Error('Rejected');
    return fn();
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
  handle('flowstate:recordings-list', () => listRecordings(dirs));
  ipcMain.handle('flowstate:recordings-read', (event, name: string) => {
    if (!isOurPage(event)) throw new Error('Rejected');
    return readRecording(dirs, name);
  });
  handle('flowstate:recorder-start', () => recorder.start(sdkVersion()));
  handle('flowstate:recorder-stop', () => recorder.stop());
  ipcMain.on('flowstate:recorder-append', (event, payload: SignalEvent) => {
    if (isOurPage(event)) recorder.append(payload);
  });
  app.on('before-quit', () => recorder.stop());
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1000,
    height: 820,
    backgroundColor: '#101218',
    title: 'FlowState',
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  bindSdk(win);
  // This window only ever shows our page, so remote content can never inherit the camera grant.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  void win.loadFile(PAGE_PATH);
}

void app.whenReady().then(() => {
  loadEnv();
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
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
