import {
  type AssistantModelManifest,
  type AssistantModelState,
  assistantModelManifest,
  type PhraseReader,
  tunedReader,
} from '@calendar/ai';
import { useSyncExternalStore } from 'react';
import { loadModelDownloadModule } from '../modules/solunivo-model-download/index.ts';
import { loadProcessMemoryModule } from '../modules/solunivo-process-memory/index.ts';
import {
  type AssistantDownload,
  type AssistantDownloadDeps,
  createAssistantDownload,
  type DownloadAnswer,
  type ModelFiles,
  type TransferPort,
} from './assistantDownload.ts';
import { type AssistantModel, createAssistantModel } from './assistantModel.ts';
import { offerOnce } from './assistantModelOffer.ts';
import { languageModel, modelFixture } from './model.ts';
import { loadOpenModelRuntime } from './openModel.ts';
import { whenSetupClosed } from './settingsCodeInbox.ts';

/**
 * The Assistant's model on this device: the download (`assistantDownload`),
 * the model the Assistant asks (`assistantModel`), and their start at
 * launch. Made once for as long as the JavaScript lives (kept on
 * `globalThis` through a Fast Refresh, as the native transfer's listeners
 * must not be added twice).
 */

/** Under this much memory an iPhone cannot hold the model beside the app: 8 GB phones report a little less. */
const MIN_PHYSICAL_BYTES = 7e9;

const override = process.env['EXPO_PUBLIC_ASSISTANT_MODEL'];

/* eslint-disable typescript/no-require-imports -- loaded lazily inside a try, as every native package here is */
const loadFiles = (): typeof import('expo-file-system') | undefined => {
  try {
    return require('expo-file-system') as typeof import('expo-file-system');
  } catch {
    return undefined;
  }
};
const loadAppState = (): typeof import('react-native').AppState | undefined => {
  try {
    return (require('react-native') as typeof import('react-native')).AppState;
  } catch {
    return undefined;
  }
};
/* eslint-enable typescript/no-require-imports */

const deviceFiles = (
  fs: typeof import('expo-file-system'),
  manifest: AssistantModelManifest,
): ModelFiles => {
  const { Directory, File, Paths } = fs;
  // Caches, not documents: 834 MB would go into every backup. The answer is kept in documents.
  const folder = new Directory(Paths.cache, 'assistant-model');
  if (!folder.exists) {
    folder.create();
  }
  const model = new File(folder, manifest.file);
  const verifiedNote = new File(folder, `${manifest.file}.verified.json`);
  const answerNote = new File(Paths.document, 'assistant-model.json');
  const readJson = (file: InstanceType<typeof File>): unknown => {
    try {
      return file.exists ? (JSON.parse(file.textSync()) as unknown) : undefined;
    } catch {
      return undefined;
    }
  };
  const writeJson = (file: InstanceType<typeof File>, value: unknown) => {
    if (!file.exists) {
      file.create();
    }
    file.write(JSON.stringify(value));
  };
  return {
    destination: model.uri,
    exists: () => model.exists,
    readAnswer: () => {
      const note = readJson(answerNote) as { answer?: unknown; version?: unknown } | undefined;
      const answer = note?.answer;
      return (answer === 'declined' || answer === 'mobile' || answer === 'wifi') &&
        typeof note?.version === 'string'
        ? { answer: answer satisfies DownloadAnswer, version: note.version }
        : undefined;
    },
    readVerified: () => {
      const note = readJson(verifiedNote) as { sha256?: unknown; version?: unknown } | undefined;
      return typeof note?.sha256 === 'string' && typeof note.version === 'string'
        ? { sha256: note.sha256, version: note.version }
        : undefined;
    },
    remove: () => {
      for (const file of [model, verifiedNote]) {
        if (file.exists) {
          file.delete();
        }
      }
    },
    sha256: () => model.digest('SHA-256'),
    size: () => (model.exists ? model.size : undefined),
    writeAnswer: (answer) => writeJson(answerNote, answer),
    writeVerified: (verified) => writeJson(verifiedNote, verified),
  };
};

const transferOf = (
  native: NonNullable<ReturnType<typeof loadModelDownloadModule>>,
): TransferPort => ({
  cancel: (destination) => native.cancel(destination),
  current: () => native.current(),
  path: () => native.path(),
  start: (url, destination, network) => native.start(url, destination, network),
  subscribe: ({ onFail, onFinish, onPath, onProgress }) => {
    const subscriptions = [
      native.addListener('onFail', onFail),
      native.addListener('onFinish', onFinish),
      native.addListener('onPath', onPath),
      native.addListener('onProgress', onProgress),
    ];
    return () => {
      for (const subscription of subscriptions) {
        subscription.remove();
      }
    };
  },
  useNetwork: (network) => native.useNetwork(network),
});

const depsOf = (): AssistantDownloadDeps => {
  if (modelFixture) {
    return { reason: 'fixture', supported: false };
  }
  const native = loadModelDownloadModule();
  if (native === undefined) {
    return { reason: 'module', supported: false };
  }
  if (loadOpenModelRuntime() === undefined) {
    return { reason: 'runtime', supported: false };
  }
  const memory = loadProcessMemoryModule();
  // A simulator fetches only a file it is pointed at: the nightly live bundle has no model fixture.
  if (memory?.isSimulator() === true && !override?.trim()) {
    return { reason: 'simulator', supported: false };
  }
  const physical = memory?.read().physical ?? 0;
  if (memory?.isSimulator() !== true && physical > 0 && physical < MIN_PHYSICAL_BYTES) {
    return { reason: 'memory', supported: false };
  }
  const manifest = assistantModelManifest(override);
  const fs = loadFiles();
  if (fs === undefined) {
    return { reason: 'module', supported: false };
  }
  return {
    files: deviceFiles(fs, manifest),
    manifest,
    supported: true,
    transfer: transferOf(native),
  };
};

interface AssistantRuntime {
  readonly download: AssistantDownload;
  readonly model: AssistantModel;
  /** The Assistant's reader: the tuned path over the app's own model, or over the fixture model (e2e). */
  readonly reader: PhraseReader;
  started: boolean;
}

const makeRuntime = (): AssistantRuntime => {
  const download = createAssistantDownload(depsOf());
  const appState = loadAppState();
  const model = createAssistantModel({
    // Inactive (Control Center pulled down, a call's banner) is still in front: only the background refuses the GPU.
    foreground: () => appState?.currentState !== 'background',
    runtime: loadOpenModelRuntime(),
    state: download.getState,
  });
  return {
    download,
    model,
    // The fixture model answers the tuned prompt in its own grammar (e2e).
    reader: tunedReader(modelFixture ? languageModel : model),
    started: false,
  };
};

const holder = globalThis as typeof globalThis & { solunivoAssistantModel?: AssistantRuntime };
const runtime = (): AssistantRuntime => (holder.solunivoAssistantModel ??= makeRuntime());

export const assistantDownload = (): AssistantDownload => runtime().download;
export const assistantModel = (): AssistantModel => runtime().model;
/** How the Assistant reads what is said: the tuned path. */
export const assistantReader = (): PhraseReader => runtime().reader;

/** The download's state, for a screen that shows it. */
export const useAssistantModelState = (): AssistantModelState => {
  const { download } = runtime();
  return useSyncExternalStore(download.subscribe, download.getState);
};

/**
 * At launch (from CalendarScreen): picks up a transfer and a file the last
 * launch left, once the app is in front; asks the question once the setup
 * is out of the way; lets the model go when the app leaves the screen,
 * and when iOS warns of memory while no question is answered.
 */
export const startAssistantModel = (ask: Parameters<typeof offerOnce>[1]): void => {
  const current = runtime();
  if (current.started) {
    return;
  }
  current.started = true;
  const appState = loadAppState();
  const begin = () => {
    void current.download.boot().then(() => {
      whenSetupClosed(() => offerOnce(current.download, ask));
    });
  };
  if (appState === undefined || appState.currentState === 'active') {
    begin();
  }
  let begun = appState === undefined || appState.currentState === 'active';
  appState?.addEventListener('change', (state) => {
    if (state === 'active' && !begun) {
      begun = true;
      begin();
    }
    if (state === 'background') {
      void current.model.leave();
    }
  });
  appState?.addEventListener('memoryWarning', () => {
    void current.model.relieve();
  });
};
