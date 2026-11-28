import {
  createParakeetStore,
  type ParakeetChoice,
  ParakeetNeedsWifi,
  type ParakeetPort,
  type ParakeetState,
  type ParakeetStore,
  readParakeetChoice,
} from '@calendar/ai';
import { Effect } from 'effect';
import { useSyncExternalStore } from 'react';
import { loadModelDownloadModule } from '../modules/solunivo-model-download/index.ts';
import { loadParakeet } from '../modules/solunivo-speech/index.ts';
import { backendClient } from './backend.ts';
import { modelFixture } from './model.ts';

/**
 * Parakeet on this iPhone (`createParakeetStore`, shared with the Mac):
 * its files in the app's caches (solunivo-speech), the switch and the
 * download asked for in `Documents/parakeet.json`, the network from
 * solunivo-model-download. Dictation reads each phrase with it once it is
 * here and the switch is on; `beforeListening` hands it the names to
 * listen for as a phrase starts. `EXPO_PUBLIC_CALENDAR_PARAKEET`: `off`
 * (nothing is fetched or loaded), `fixture` (a download that finishes at
 * once and nothing loaded, for screenshots and the e2e flows' screens).
 * A bundle on the fixture model (the CI and e2e bundles) leaves it out
 * unless it asks for the fixture: those flows read words from a script.
 */
const SWITCH = process.env['EXPO_PUBLIC_CALENDAR_PARAKEET'] ?? (modelFixture ? 'off' : undefined);

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

/** The switch and the download asked for, kept beside the app's other notes. */
const choiceFile = (fs: typeof import('expo-file-system')) => {
  const file = new fs.File(fs.Paths.document, 'parakeet.json');
  return {
    read: async (): Promise<ParakeetChoice | undefined> => {
      try {
        return file.exists ? readParakeetChoice(JSON.parse(file.textSync())) : undefined;
      } catch {
        return undefined;
      }
    },
    write: async (choice: ParakeetChoice) => {
      if (!file.exists) {
        file.create();
      }
      file.writeSync(JSON.stringify(choice));
    },
  };
};

/** The e2e flows' Parakeet: kept in memory, a download that is done at once, nothing loaded. */
const fixturePort = (): ParakeetPort => {
  let here = false;
  let choice: ParakeetChoice | undefined;
  return {
    cancel: () => undefined,
    download: async (onProgress) => {
      onProgress(1);
      here = true;
    },
    files: async () => ({ bytes: here ? 712_000_000 : 0, here }),
    readChoice: async () => choice,
    remove: async () => {
      here = false;
    },
    use: async () => undefined,
    writeChoice: async (next) => {
      choice = next;
    },
  };
};

const devicePort = (): ParakeetPort | undefined => {
  const native = loadParakeet();
  const fs = loadFiles();
  if (native === undefined || fs === undefined) {
    return undefined;
  }
  const choice = choiceFile(fs);
  const network = loadModelDownloadModule();
  const appState = loadAppState();
  return {
    active: () => appState === undefined || appState.currentState === 'active',
    cancel: () => native.parakeetCancel(),
    download: async (onProgress, wifiOnly) => {
      const listening = native.addListener('onParakeetProgress', ({ fraction }) =>
        onProgress(fraction),
      );
      try {
        await native.parakeetDownload(wifiOnly);
      } catch (error) {
        throw (error as { code?: unknown }).code === 'ParakeetNeedsWifi'
          ? new ParakeetNeedsWifi()
          : error;
      } finally {
        listening.remove();
      }
    },
    files: () => native.parakeetState(),
    prepare: () => native.parakeetPrepare(),
    ...(network === undefined
      ? {}
      : {
          network: {
            path: () => network.path(),
            subscribe: (listener) => {
              const subscription = network.addListener('onPath', listener);
              return () => subscription.remove();
            },
          },
        }),
    readChoice: choice.read,
    remove: () => native.parakeetRemove(),
    use: (on, vocabulary, people) => native.parakeetUse(on, [...vocabulary], [...people]),
    writeChoice: choice.write,
  };
};

const makeStore = (): ParakeetStore => {
  if (SWITCH === 'off') {
    return createParakeetStore({ reason: 'off', supported: false });
  }
  const port = SWITCH === 'fixture' ? fixturePort() : devicePort();
  return port === undefined
    ? createParakeetStore({ reason: 'module', supported: false })
    : createParakeetStore({ port, supported: true });
};

const holder = globalThis as typeof globalThis & {
  solunivoParakeet?: { started: boolean; store: ParakeetStore };
};
const runtime = () => (holder.solunivoParakeet ??= { started: false, store: makeStore() });

export const parakeet = (): ParakeetStore => runtime().store;

/** Parakeet's state, for a screen that shows it. */
export const useParakeetState = (): ParakeetState =>
  useSyncExternalStore(runtime().store.subscribe, runtime().store.getState);

/**
 * As a phrase starts (`appleSpeech.start`): the names to listen for, read
 * from the calendar and the address books (at most every five minutes,
 * by the backend), handed to Parakeet when dictation reads with it. A
 * failure leaves the last names in place.
 */
export const beforeListening = async (): Promise<void> => {
  const { store } = runtime();
  const { files, on } = store.getState();
  if (!on || files.kind !== 'ready') {
    return;
  }
  const names = await Effect.runPromise(backendClient.dictationVocabulary()).catch(() => undefined);
  if (names !== undefined) {
    await store.vocabulary([...names.people, ...names.places], names.people);
  }
};

/** A Speech Spike run holds the engine: a memory warning must not take its model mid-run. */
let spikeRun = false;

/** The Speech Spike page's run begins (true) or ends (false). */
export const holdParakeetForSpike = (on: boolean): void => {
  spikeRun = on;
};

/**
 * At launch (from CalendarScreen): the choice kept and the files found,
 * once the app is in front; a download the background cut goes on when it
 * is back. Nothing is asked here: the Create lesson, Settings › Dictation
 * and Settings › Assistant offer the download.
 */
export const startParakeet = (): void => {
  const current = runtime();
  if (current.started) {
    return;
  }
  current.started = true;
  const appState = loadAppState();
  let begun = appState === undefined || appState.currentState === 'active';
  if (begun) {
    void current.store.boot();
  }
  // iOS warned of memory: the models go, as the Assistant's context does.
  appState?.addEventListener('memoryWarning', () => {
    // A Speech Spike run counts the warnings it measures; its model stays.
    if (!spikeRun) {
      void loadParakeet()
        ?.parakeetRelieve()
        .catch(() => undefined);
    }
  });
  appState?.addEventListener('change', (state) => {
    if (state === 'background') {
      // As the Assistant's model does: the next phrase loads it again.
      void loadParakeet()
        ?.parakeetRelieve()
        .catch(() => undefined);
      return;
    }
    if (state !== 'active') {
      return;
    }
    if (!begun) {
      begun = true;
      void current.store.boot();
    } else {
      current.store.resume();
    }
  });
};
