import '@smartspectra/node-sdk/preload';
import { contextBridge, ipcRenderer } from 'electron';
import type { AppStatus, FlowstateBridge, SensingCommand } from '../shared/types';

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const wrapped = (_event: unknown, value: T) => listener(value);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

const bridge: FlowstateBridge = {
  hasApiKey: () => ipcRenderer.invoke('flowstate:has-api-key'),
  getApiKey: () => ipcRenderer.invoke('flowstate:get-api-key'),
  saveApiKey: (key) => ipcRenderer.invoke('flowstate:save-api-key', key),
  getSettings: () => ipcRenderer.invoke('flowstate:get-settings'),
  updateSettings: (patch) => ipcRenderer.invoke('flowstate:update-settings', patch),
  deleteLocalData: () => ipcRenderer.invoke('flowstate:delete-local-data'),
  listRecordings: () => ipcRenderer.invoke('flowstate:recordings-list'),
  readRecording: (name) => ipcRenderer.invoke('flowstate:recordings-read', name),
  recorderStart: () => ipcRenderer.invoke('flowstate:recorder-start'),
  recorderAppend: (event) => ipcRenderer.send('flowstate:recorder-append', event),
  recorderStop: () => ipcRenderer.invoke('flowstate:recorder-stop'),
  sendFeatures: (features) => ipcRenderer.send('flowstate:features', features),
  reportSdkMs: (ms) => ipcRenderer.send('flowstate:sdk-ms', ms),
  reportSensing: (source, cameraOn) => ipcRenderer.send('flowstate:sensing', source, cameraOn),
  setOverride: (override, forMinutes) => ipcRenderer.send('flowstate:set-override', override, forMinutes),
  getStatus: () => ipcRenderer.invoke('flowstate:get-status'),
  onStatus: (listener) => subscribe<AppStatus>('flowstate:status', listener),
  onCommand: (listener) => subscribe<SensingCommand>('flowstate:command', listener),
};

contextBridge.exposeInMainWorld('flowstate', bridge);
contextBridge.exposeInMainWorld('flowstateDemo', process.argv.includes('--flowstate-demo'));
