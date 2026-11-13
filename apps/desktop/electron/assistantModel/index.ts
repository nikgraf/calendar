import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type AssistantModelState,
  assistantModelManifest,
  makeFixtureLanguageModel,
} from '@calendar/ai';
import { app, BrowserWindow, ipcMain } from 'electron';
import { modelFolder, nodeFetch, nodeModelFiles } from './files.ts';
import { createLlamaServer, reapLeftovers, socketPathFor } from './server.ts';
import { type AssistantStore, createAssistantStore } from './store.ts';

/**
 * The Assistant's own model on the Mac (the release `@calendar/ai` names,
 * the iPhone's too): downloaded into the profile once the person asks for
 * it (the Create lesson's banner, the Assistant's notice, Settings),
 * run by the bundled `llama-server`, asked over `assistant:generate` by the
 * renderer's tuned reader. Apple's model and a served one keep answering
 * find a time, search and capture (`model:*`, modelHelper.ts).
 *
 * Switches: CALENDAR_MODEL=fixture answers with the deterministic model
 * from @calendar/ai and reports ready (the e2e harness);
 * CALENDAR_ASSISTANT_MODEL=off leaves it out (the harness's default:
 * nothing offered, nothing downloaded). For a run from source,
 * CALENDAR_ASSISTANT_MODEL_FILE=<gguf> uses a file in place of the
 * download, and CALENDAR_ASSISTANT_MANIFEST=<json> fetches another file
 * (one served from this Mac).
 */

/** Room for the tuned prompt: the day list, a draft with short notes, six earlier turns. */
const MAX_PROMPT_CHARS = 20_000;

const fixture =
  process.env['CALENDAR_MODEL'] === 'fixture' ? makeFixtureLanguageModel() : undefined;

const llamaServerPath = (): string | null => {
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'llama-server')
    : join(__dirname, '..', 'llama', '.build', 'llama-server');
  return existsSync(candidate) ? candidate : null;
};

/** Where the state comes from: fixed (fixture, off, no runtime, a dev file) or the download store. */
type Source =
  | { readonly kind: 'fixed'; readonly state: AssistantModelState }
  | { readonly kind: 'store'; readonly store: AssistantStore };

const sourceOf = (userDataDir: string): Source => {
  if (fixture) {
    return { kind: 'fixed', state: { kind: 'unsupported', reason: 'fixture' } };
  }
  if (process.env['CALENDAR_ASSISTANT_MODEL'] === 'off') {
    return { kind: 'fixed', state: { kind: 'unsupported', reason: 'off' } };
  }
  if (llamaServerPath() === null) {
    return { kind: 'fixed', state: { kind: 'unsupported', reason: 'runtime' } };
  }
  const file = process.env['CALENDAR_ASSISTANT_MODEL_FILE'];
  if (file?.trim()) {
    return { kind: 'fixed', state: { kind: 'ready', path: file } };
  }
  const manifest = assistantModelManifest(process.env['CALENDAR_ASSISTANT_MANIFEST']);
  const folder = modelFolder(userDataDir);
  return {
    kind: 'store',
    store: createAssistantStore({
      fetch: nodeFetch(folder, manifest),
      files: nodeModelFiles(folder, manifest),
      manifest,
    }),
  };
};

const isPrompt = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= MAX_PROMPT_CHARS;

/** The answer from its first brace: the model writes nothing before it, a chat template might. */
const jsonOf = (text: string): string => {
  const start = text.indexOf('{');
  if (start === -1) {
    throw new Error('The Assistant’s model gave no answer.');
  }
  return text.slice(start);
};

export const registerAssistantModel = (userDataDir: string): void => {
  const source = sourceOf(userDataDir);
  const binary = llamaServerPath();
  const pidFile = join(userDataDir, 'llama-server.pid');
  if (binary !== null) {
    reapLeftovers({ binary, pidFile, socketFolder: tmpdir() });
  }
  const server =
    binary === null
      ? undefined
      : createLlamaServer({
          binary,
          pidFile,
          socketPath: socketPathFor(tmpdir(), process.pid),
        });
  const stateNow = (): AssistantModelState =>
    source.kind === 'fixed' ? source.state : source.store.getState();
  const follow = (state: AssistantModelState) => {
    if (state.kind === 'ready') {
      server?.use(state.path);
    }
  };
  follow(stateNow());

  if (source.kind === 'store') {
    source.store.subscribe((state) => {
      follow(state);
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('assistant:changed', state);
      }
    });
    void source.store.boot();
  }

  ipcMain.handle('assistant:state', () => stateNow());
  ipcMain.handle('assistant:download', () => {
    if (source.kind === 'store') {
      void source.store.agree();
    }
  });
  ipcMain.handle('assistant:retry', () => {
    if (source.kind === 'store') {
      void source.store.retry();
    }
  });
  ipcMain.handle('assistant:generate', async (_event, prompt: unknown) => {
    if (!isPrompt(prompt)) {
      throw new Error('assistant: invalid prompt');
    }
    if (fixture) {
      return {
        json: JSON.stringify(await fixture.generateJson({ jsonSchema: undefined, prompt })),
      };
    }
    const state = stateNow();
    if (state.kind !== 'ready' || server === undefined) {
      throw new Error('The Assistant’s model is not on this Mac yet.');
    }
    // The file went (removed by hand, a cleaner): the store looks again,
    // and fetches it once more where the person had agreed.
    if (source.kind === 'store' && !existsSync(state.path)) {
      void source.store.boot();
      throw new Error('The Assistant’s model is not on this Mac any more.');
    }
    return { json: jsonOf(await server.ask(prompt)) };
  });
  app.on('will-quit', () => {
    server?.stop();
    if (source.kind === 'store') {
      source.store.stop();
    }
  });
};
