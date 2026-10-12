import { fixtureTextRecognizer, makeFixtureLanguageModel } from '@calendar/ai';
import { ipcMain, systemPreferences } from 'electron';
import { callHelper, registerHelperLifecycle } from './helperProcess.ts';
import {
  getModelProvider,
  providerGenerate,
  providerInfo,
  providerStatus,
  servedModelActive,
  setModelProvider,
  testModelProvider,
} from './modelProvider.ts';

/**
 * Exposes the model seam to the renderer over plain preload IPC — model
 * calls are a window-level concern, not calendar data, so they stay off
 * the rpc seam by design. `model:generate` and `model:status` go to the
 * active provider (modelProvider.ts): the Swift helper's Foundation
 * Models by default, or a model served over HTTP; dictation and text
 * recognition always go to the helper. The process itself lives in
 * helperProcess.ts.
 */
/**
 * Input bounds for the renderer-facing handlers. `privacy:set` allowlists
 * its argument; these used to forward raw `unknown` — including an
 * unbounded audio payload — straight onto the helper's stdin.
 */
const MAX_SCHEMA_CHARS = 64_000;
/** Room for capture's largest budget (60k characters of a paste) plus the prompt's own words. */
const MAX_PROMPT_CHARS = 80_000;
/** ~18 MB of 16 kHz mono 16-bit WAV, several minutes of dictation. */
const MAX_AUDIO_BASE64_CHARS = 24_000_000;
/** ~18 MB of image: a full Retina screenshot as PNG is a few. */
const MAX_IMAGE_BASE64_CHARS = 24_000_000;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/**
 * CALENDAR_MODEL=fixture (the e2e harness): the deterministic model and
 * recognizer from @calendar/ai answer in place of any provider, after the
 * same validation, so preload and IPC stay on the tested path while a run
 * no longer depends on the machine having Apple Intelligence.
 */
const fixture =
  process.env['CALENDAR_MODEL'] === 'fixture'
    ? { model: makeFixtureLanguageModel(), recognizer: fixtureTextRecognizer }
    : undefined;

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const invalid = (what: string): Promise<never> =>
  Promise.reject(new Error(`model: invalid ${what}`));

/** The helper's status, or what its absence means (no binary, a crash): the renderer maps both. */
const appleStatus = async (): Promise<{ detail?: string; status: string }> => {
  try {
    return (await callHelper('status')) as { detail?: string; status: string };
  } catch {
    return { detail: 'helperUnavailable', status: 'unavailable' };
  }
};

export const registerModelHelper = (): void => {
  ipcMain.handle('model:status', async () => {
    if (fixture) {
      return { provider: 'apple', status: 'ready' };
    }
    return providerStatus(appleStatus);
  });
  ipcMain.handle('model:info', () =>
    fixture ? { contextTokens: 4096, name: 'Fixture model' } : providerInfo(),
  );
  // The helper itself, whatever provider answers generation: dictation and
  // text recognition are its alone, so their support is read here.
  // `helper` says the binary answered at all: SpeechAnalyzer needs macOS 26
  // and the helper, not Apple Intelligence, so dictation reads that and the
  // OS reason, never the model's availability.
  ipcMain.handle('model:helper-status', async () => {
    if (fixture) {
      return { helper: true, status: 'ready' };
    }
    const apple = await appleStatus();
    return { ...apple, helper: apple.detail !== 'helperUnavailable' };
  });
  ipcMain.handle('model:generate', async (_event, schema: unknown, prompt: unknown) => {
    if (!isJsonObject(schema) || JSON.stringify(schema).length > MAX_SCHEMA_CHARS) {
      return invalid('schema');
    }
    if (typeof prompt !== 'string' || prompt.length > MAX_PROMPT_CHARS) {
      return invalid('prompt');
    }
    if (fixture) {
      return {
        json: JSON.stringify(await fixture.model.generateJson({ jsonSchema: schema, prompt })),
      };
    }
    if (servedModelActive()) {
      return providerGenerate(schema, prompt);
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
  // Bytes only: the renderer never names a path, so the helper reads
  // nothing but what was pasted.
  ipcMain.handle('model:recognize-text', async (_event, imageBase64: unknown) => {
    if (typeof imageBase64 !== 'string' || imageBase64.length > MAX_IMAGE_BASE64_CHARS) {
      return invalid('image');
    }
    if (fixture) {
      return {
        text: await fixture.recognizer.recognizeText({ base64: imageBase64, kind: 'base64' }),
      };
    }
    return callHelper('ocr.recognizeText', { imageBase64 });
  });
  // The provider itself: read, changed (checked field by field in
  // modelProvider.ts) and probed from the settings window.
  ipcMain.handle('model:provider-get', () => getModelProvider());
  ipcMain.handle('model:provider-set', (_event, changes: unknown) => setModelProvider(changes));
  ipcMain.handle('model:provider-test', (_event, candidate: unknown) =>
    testModelProvider(candidate),
  );
  registerHelperLifecycle();
};
