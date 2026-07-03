import { contextBridge, ipcRenderer } from 'electron';

// The renderer's only door into the main process: a duplex frame channel
// carrying the AppBackend rpc protocol (see packages/core/src/backend.ts).
contextBridge.exposeInMainWorld('calendarBridge', {
  onRpcMessage: (listener: (data: string | Uint8Array) => void) => {
    const wrapped = (_event: unknown, data: string | Uint8Array) => listener(data);
    ipcRenderer.on('rpc', wrapped);
    return () => ipcRenderer.off('rpc', wrapped);
  },
  rpcSend: (data: string | Uint8Array) => ipcRenderer.send('rpc', data),
});
