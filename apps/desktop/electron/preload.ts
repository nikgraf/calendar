import { contextBridge, ipcRenderer } from 'electron';

// The renderer's only door into the main process: one Schema-validated
// invoke channel plus a data-change signal (see packages/core/src/backend.ts).
contextBridge.exposeInMainWorld('calendarBridge', {
  invoke: (method: string, payload: unknown) => ipcRenderer.invoke('backend', method, payload),
  onChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on('backend:changed', wrapped);
    return () => ipcRenderer.off('backend:changed', wrapped);
  },
});
