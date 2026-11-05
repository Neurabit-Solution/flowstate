import '@smartspectra/node-sdk/preload';
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('flowstate', {
  hasApiKey: () => ipcRenderer.invoke('flowstate:has-api-key'),
  getApiKey: () => ipcRenderer.invoke('flowstate:get-api-key'),
  listRecordings: () => ipcRenderer.invoke('flowstate:recordings-list'),
  readRecording: (name: string) => ipcRenderer.invoke('flowstate:recordings-read', name),
  recorderStart: () => ipcRenderer.invoke('flowstate:recorder-start'),
  recorderAppend: (event: unknown) => ipcRenderer.send('flowstate:recorder-append', event),
  recorderStop: () => ipcRenderer.invoke('flowstate:recorder-stop'),
});
