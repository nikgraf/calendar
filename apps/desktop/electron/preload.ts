import { contextBridge, ipcRenderer } from 'electron';

// The renderer's only door into the main process: one Schema-validated
// invoke channel plus the invalidation-key stream (see core/backend.ts).
contextBridge.exposeInMainWorld('calendarBridge', {
  invoke: (method: string, payload: unknown) => ipcRenderer.invoke('backend', method, payload),
  onInvalidated: (listener: (keys: ReadonlyArray<unknown>) => void) => {
    const wrapped = (_event: unknown, keys: ReadonlyArray<unknown>) => listener(keys);
    ipcRenderer.on('backend:invalidated', wrapped);
    return () => ipcRenderer.off('backend:invalidated', wrapped);
  },
});
