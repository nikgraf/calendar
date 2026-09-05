import { ipcMain, systemPreferences } from 'electron';
import { callHelper, registerHelperLifecycle } from './helperProcess.ts';

/**
 * Exposes the Swift helper's model methods (Foundation Models +
 * SpeechAnalyzer) to the renderer over plain preload IPC — model calls
 * are a window-level concern, not calendar data, so they stay off the rpc
 * seam by design. The process itself lives in helperProcess.ts.
 */
export const registerModelHelper = (): void => {
  ipcMain.handle('model:status', async () => {
    try {
      return await callHelper('status');
    } catch {
      // No helper binary or a crash: same shape the renderer maps to
      // 'missing-module' / 'unavailable'.
      return { detail: 'helperUnavailable', status: 'unavailable' };
    }
  });
  ipcMain.handle('model:generate', (_event, schema: unknown, prompt: unknown) =>
    callHelper('generateJson', { prompt, schema }),
  );
  ipcMain.handle('model:prepare-speech', async (_event, locale: unknown) => {
    // The OS mic prompt needs a main-process ask; denial is a typed state,
    // not an exception, so the renderer can map MicrophoneDeniedError.
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      return { denied: true };
    }
    return callHelper('prepareSpeech', { locale });
  });
  ipcMain.handle('model:transcribe', (_event, audioBase64: unknown, locale: unknown) =>
    callHelper('transcribe', { audioBase64, locale }),
  );
  registerHelperLifecycle();
};
