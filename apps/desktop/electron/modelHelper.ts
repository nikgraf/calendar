import { fixtureTextRecognizer, makeFixtureLanguageModel, type WordsSource } from '@calendar/ai';
import { ipcMain, systemPreferences, type WebContents } from 'electron';
import { callHelper, onHelperEvent, registerHelperLifecycle } from './helperProcess.ts';
import { fixtureListening, microphoneFixture } from './microphoneFixture.ts';
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
/** One block of the microphone: the renderer sends 100 ms (3,200 bytes); a second is plenty. */
const MAX_AUDIO_BLOCK_BYTES = 32_000;
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
  // text recognition are its alone, so their support is read here. The
  // reply is only whether the binary answered: SpeechAnalyzer needs the
  // helper, not Apple Intelligence, so the model's availability never
  // reaches dictation's support check.
  ipcMain.handle('model:helper-status', async () => {
    if (fixture) {
      return { helper: true };
    }
    const apple = await appleStatus();
    return { helper: apple.detail !== 'helperUnavailable' };
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
    // The fixture's microphone is a file: nothing to ask, nothing to install.
    if (microphoneFixture) {
      return { prepared: true };
    }
    // The OS mic prompt needs a main-process ask; denial is a typed state,
    // not an exception, so the renderer can map MicrophoneDeniedError.
    const granted = await systemPreferences.askForMediaAccess('microphone');
    if (!granted) {
      return { denied: true };
    }
    return callHelper('prepareSpeech', { locale });
  });
  registerSpeech();
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

/**
 * The phrase being listened to, and the window listening: its words go
 * there only, and audio from anywhere else is not taken.
 */
let listening: { readonly owner: WebContents; readonly session: number } | null = null;
let sessions = 0;

const sendWords = (session: number, source: WordsSource, text: string) => {
  const current = listening;
  if (current?.session === session && !current.owner.isDestroyed()) {
    current.owner.send('model:speech-words', { session, source, text });
  }
};

const isSession = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Dictation, one phrase at a time: the renderer owns the microphone and
 * streams it here (`model:speech-audio`, 16 kHz mono Int16 blocks); the
 * helper's recognisers write the words as they are said
 * (`model:speech-words`, pushed to the window listening); the renderer
 * decides when the phrase ended and asks for it read whole
 * (`model:speech-finish`). Under the e2e fixture the same calls answer
 * from `microphoneFixture.ts`.
 */
const registerSpeech = () => {
  onHelperEvent('speech.words', (body) => {
    const { session, source, text } = body;
    if (
      isSession(session) &&
      (source === 'accurate' || source === 'quick') &&
      typeof text === 'string'
    ) {
      sendWords(session, source, text);
    }
  });
  ipcMain.handle('model:speech-start', async (event, locale: unknown) => {
    if (typeof locale !== 'string' || !LOCALE.test(locale)) {
      return invalid('locale');
    }
    sessions += 1;
    const session = sessions;
    listening = { owner: event.sender, session };
    if (microphoneFixture) {
      fixtureListening.start(session, (source, text) => sendWords(session, source, text));
    } else {
      await callHelper('speech.start', { locale, session });
    }
    return { session };
  });
  ipcMain.on('model:speech-audio', (event, session: unknown, pcm: unknown) => {
    if (
      !isSession(session) ||
      listening?.session !== session ||
      listening.owner !== event.sender ||
      !ArrayBuffer.isView(pcm) ||
      pcm.byteLength > MAX_AUDIO_BLOCK_BYTES
    ) {
      return;
    }
    const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (microphoneFixture) {
      fixtureListening.audio(session, bytes);
      return;
    }
    callHelper('speech.audio', {
      pcmBase64: Buffer.from(bytes).toString('base64'),
      session,
    }).catch(() => undefined);
  });
  ipcMain.handle('model:speech-finish', (_event, session: unknown) => {
    if (!isSession(session)) {
      return invalid('session');
    }
    if (listening?.session === session) {
      listening = null;
    }
    return microphoneFixture
      ? fixtureListening.finish(session)
      : callHelper('speech.finish', { session });
  });
  ipcMain.handle('model:speech-cancel', async (_event, session: unknown) => {
    if (!isSession(session)) {
      return invalid('session');
    }
    if (listening?.session === session) {
      listening = null;
    }
    if (microphoneFixture) {
      fixtureListening.cancel(session);
      return {};
    }
    return callHelper('speech.cancel', { session });
  });
};
