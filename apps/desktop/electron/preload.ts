import { contextBridge, ipcRenderer } from 'electron';

// The renderer's only door into the main process: a duplex frame channel
// carrying the AppBackend rpc protocol (see packages/core/src/backend.ts).
contextBridge.exposeInMainWorld('calendarBridge', {
  logError: (text: string) => ipcRenderer.send('renderer-error', text),
  onPrivacyChanged: (listener: (state: unknown) => void) => {
    const wrapped = (_event: unknown, state: unknown) => listener(state);
    ipcRenderer.on('privacy:changed', wrapped);
    return () => ipcRenderer.off('privacy:changed', wrapped);
  },
  onRpcMessage: (listener: (data: string | Uint8Array) => void) => {
    const wrapped = (_event: unknown, data: string | Uint8Array) => listener(data);
    ipcRenderer.on('rpc', wrapped);
    return () => ipcRenderer.off('rpc', wrapped);
  },
  privacyGet: () => ipcRenderer.invoke('privacy:get'),
  privacySet: (choice: string) => ipcRenderer.invoke('privacy:set', choice),
  rpcSend: (data: string | Uint8Array) => ipcRenderer.send('rpc', data),
});
