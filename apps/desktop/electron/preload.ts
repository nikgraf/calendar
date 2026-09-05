import { contextBridge, ipcRenderer } from 'electron';

// The renderer's only door into the main process: a duplex frame channel
// carrying the AppBackend rpc protocol (see packages/core/src/backend.ts).
contextBridge.exposeInMainWorld('calendarBridge', {
  logError: (text: string) => ipcRenderer.send('renderer-error', text),
  modelGenerate: (schema: unknown, prompt: string) =>
    ipcRenderer.invoke('model:generate', schema, prompt),
  modelPrepareSpeech: (locale: string) => ipcRenderer.invoke('model:prepare-speech', locale),
  modelStatus: () => ipcRenderer.invoke('model:status'),
  modelTranscribe: (audioBase64: string, locale: string) =>
    ipcRenderer.invoke('model:transcribe', audioBase64, locale),
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
  remindersStatus: () => ipcRenderer.invoke('reminders:status'),
  rpcSend: (data: string | Uint8Array) => ipcRenderer.send('rpc', data),
});
