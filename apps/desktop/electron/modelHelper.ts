import { ipcMain, systemPreferences } from 'electron';
import { callHelper, registerHelperLifecycle } from './helperProcess.ts';

/**
 * Exposes the Swift helper's model methods (Foundation Models +
 * SpeechAnalyzer) to the renderer over plain preload IPC — model calls
 * are a window-level concern, not calendar data, so they stay off the rpc
 * seam by design. The process itself lives in helperProcess.ts.
 */
/**
 * Input bounds for the renderer-facing handlers. `privacy:set` allowlists
 * its argument; these used to forward raw `unknown` — including an
 * unbounded audio payload — straight onto the helper's stdin.
 */
const MAX_SCHEMA_CHARS = 64_000;
const MAX_PROMPT_CHARS = 32_000;
/** ~18 MB of 16 kHz mono 16-bit WAV, several minutes of dictation. */
const MAX_AUDIO_BASE64_CHARS = 24_000_000;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (what: string): Promise<never> =>
  Promise.reject(new Error(`model: invalid ${what}`));

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
  ipcMain.handle('model:generate', (_event, schema: unknown, prompt: unknown) => {
    if (!isJsonObject(schema) || JSON.stringify(schema).length > MAX_SCHEMA_CHARS) {
      return invalid('schema');
    }
    if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) {
      return invalid('prompt');
    }
    return callHelper('generateJson', { prompt, schema });
  });
  ipcMain.handle('model:prepare-speech', async (_event, locale: unknown) => {
    if (typeof locale !== 'string' || !LOCALE.test(locale)) {
      return invalid('locale');
    }
    // The OS mic prompt needs a main-process ask; denial is a typed state,
    // not an exception, so the renderer can map MicrophoneDeniedError.
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      return { denied: true };
    }
    return callHelper('prepareSpeech', { locale });
  });
  ipcMain.handle('model:transcribe', (_event, audioBase64: unknown, locale: unknown) => {
    if (typeof audioBase64 !== 'string' || audioBase64.length > MAX_AUDIO_BASE64_CHARS) {
      return invalid('audio');
    }
    if (typeof locale !== 'string' || !LOCALE.test(locale)) {
      return invalid('locale');
    }
    return callHelper('transcribe', { audioBase64, locale });
  });
  registerHelperLifecycle();
};
