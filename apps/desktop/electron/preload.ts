import { contextBridge, ipcRenderer } from 'electron';

// The renderer's only door into the main process: one Schema-validated
// invoke channel (see packages/core/src/backend.ts). No ad-hoc IPC.
contextBridge.exposeInMainWorld('calendarBridge', {
  invoke: (method: string, payload: unknown) => ipcRenderer.invoke('backend', method, payload),
});
