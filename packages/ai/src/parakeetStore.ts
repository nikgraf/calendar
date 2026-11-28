import type { NetworkReading } from './assistantModel.ts';
import {
  PARAKEET_DEFAULT,
  type ParakeetChoice,
  type ParakeetFilesState,
  type ParakeetState,
  type ParakeetUnsupported,
  readsWithParakeet,
} from './parakeetModel.ts';

/**
 * Parakeet on a device, for both apps: the switch (Settings › Dictation ›
 * Read With Parakeet, on from the start), the download the person asked
 * for, and whether dictation reads with it. The platform does the work
 * through `ParakeetPort` (iOS: solunivo-speech; Mac: the helper over
 * Electron main); this decides when. Plain TypeScript over a port, as the
 * Assistant's download stores are.
 */
export interface ParakeetPort {
  /** Whether the app is in front: a download that fails behind it goes on once it is back. */
  readonly active?: () => boolean;
  readonly cancel: () => void;
  /**
   * Fetches what is missing of both models; rejects after `cancel`, and
   * with `ParakeetNeedsWifi` when `wifiOnly` and the network turned to
   * mobile data or Low Data Mode (the platform stops it at once).
   */
  readonly download: (onProgress: (fraction: number) => void, wifiOnly: boolean) => Promise<void>;
  readonly files: () => Promise<{ readonly bytes: number; readonly here: boolean }>;
  /** The iPhone's network: without it the download never waits for Wi-Fi (the Mac). */
  readonly network?: {
    readonly path: () => NetworkReading;
    readonly subscribe: (listener: (path: NetworkReading) => void) => () => void;
  };
  /** Loads the models in the background (as a phrase starts); nothing where they are loaded. */
  readonly prepare?: () => Promise<void>;
  readonly readChoice: () => Promise<ParakeetChoice | undefined>;
  readonly remove: () => Promise<void>;
  /**
   * Dictation reads with Parakeet, with these names, or no longer does;
   * `people` says which of them are people's (a closer match, #385).
   */
  readonly use: (
    on: boolean,
    vocabulary: ReadonlyArray<string>,
    people: ReadonlyArray<string>,
  ) => Promise<void>;
  readonly writeChoice: (choice: ParakeetChoice) => Promise<void>;
}

export type ParakeetStoreDeps =
  | { readonly reason: ParakeetUnsupported; readonly supported: false }
  | { readonly port: ParakeetPort; readonly supported: true };

export interface ParakeetStore {
  /** Over mobile data too, after the person said so (iPhone). */
  readonly allowMobileData: () => Promise<void>;
  /** At app start: the choice kept, the files found, a download asked for picked up. */
  readonly boot: () => Promise<void>;
  /** Fetches Parakeet (and switches it on): over Wi-Fi only (`wifi`), or any network. */
  readonly download: (network: 'any' | 'wifi') => Promise<void>;
  readonly getState: () => ParakeetState;
  /** The network now, for the offer's wording. */
  readonly network: () => NetworkReading | undefined;
  /** Deletes the files; the switch stays as it was, and the download is offered again. */
  readonly remove: () => Promise<void>;
  /** The app is in front again: a download the background cut goes on. */
  readonly resume: () => void;
  readonly retry: () => Promise<void>;
  /** The switch; off also stops a download under way. */
  readonly setOn: (on: boolean) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
  /**
   * As a phrase starts: the names dictation listens for, handed on when it
   * reads with Parakeet, and its models loaded meanwhile; `people` are the
   * terms that are people's names.
   */
  readonly vocabulary: (
    terms: ReadonlyArray<string>,
    people?: ReadonlyArray<string>,
  ) => Promise<void>;
}

/** What every action does where the build has no Parakeet. */
const nothing = async (): Promise<void> => undefined;

/** The platform stopped a Wi-Fi-only download: the network turned to mobile data or Low Data Mode. */
export class ParakeetNeedsWifi extends Error {
  constructor() {
    super('Parakeet downloads on Wi-Fi only.');
    this.name = 'ParakeetNeedsWifi';
  }
}

const needsWifi = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { readonly name?: unknown }).name === 'ParakeetNeedsWifi';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Where a download stands: its last progress, kept while it waits. */
const progressOf = (files: ParakeetFilesState): number =>
  files.kind === 'downloading' || files.kind === 'waiting' ? files.progress : 0;

export const createParakeetStore = (deps: ParakeetStoreDeps): ParakeetStore => {
  const listeners = new Set<() => void>();
  let state: ParakeetState = deps.supported
    ? { files: { kind: 'absent' }, on: PARAKEET_DEFAULT.on }
    : { files: { kind: 'unsupported', reason: deps.reason }, on: false };
  const set = (next: Partial<ParakeetState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) {
      listener();
    }
  };
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  if (!deps.supported) {
    return {
      allowMobileData: nothing,
      boot: nothing,
      download: nothing,
      getState: () => state,
      network: () => undefined,
      remove: nothing,
      resume: () => undefined,
      retry: nothing,
      setOn: nothing,
      subscribe,
      vocabulary: nothing,
    };
  }
  const { port } = deps;
  let choice: ParakeetChoice = PARAKEET_DEFAULT;
  let terms: ReadonlyArray<string> = [];
  let people: ReadonlyArray<string> = [];
  /** The download under way, so a second ask joins it. */
  let running: Promise<void> | undefined;
  /**
   * Which download counts: one stopped on purpose (the network, the switch,
   * a delete) is no longer it, so its late end is neither a failure nor a
   * success, and a new one can start before the cancel lands.
   */
  let current = 0;
  /** Cut by the background: goes on with `resume`. */
  let paused = false;
  let watching: (() => void) | undefined;

  const apply = () =>
    port
      .use(
        readsWithParakeet(state),
        readsWithParakeet(state) ? terms : [],
        readsWithParakeet(state) ? people : [],
      )
      .catch(() => undefined);

  const remember = async (next: ParakeetChoice) => {
    choice = next;
    await port.writeChoice(next).catch(() => undefined);
  };

  /** What the network allows now: the download, or the wait it needs. */
  const blockedBy = (): 'network' | 'wifi' | undefined => {
    const path = port.network?.path();
    if (path === undefined) {
      return undefined;
    }
    if (!path.satisfied) {
      return 'network';
    }
    return choice.download === 'wifi' && (path.expensive || path.constrained) ? 'wifi' : undefined;
  };

  const settle = async () => {
    const found = await port.files().catch(() => ({ bytes: 0, here: false }));
    set({
      files: found.here
        ? { bytes: found.bytes, kind: 'ready' }
        : { kind: 'failed', message: 'Not every file of Parakeet arrived.' },
    });
    await apply();
    // The Neural Engine prepares a new download once, for half a minute:
    // now, not while the first phrase waits.
    if (readsWithParakeet(state)) {
      await port.prepare?.().catch(() => undefined);
    }
  };

  const run = (): Promise<void> => {
    if (running !== undefined) {
      return running;
    }
    current += 1;
    const mine = current;
    paused = false;
    set({ files: { kind: 'downloading', progress: progressOf(state.files) } });
    running = port
      .download((fraction) => {
        if (mine === current && state.files.kind === 'downloading') {
          set({ files: { kind: 'downloading', progress: fraction } });
        }
      }, choice.download === 'wifi')
      .then(
        () => (mine === current ? settle() : undefined),
        (error: unknown) => {
          if (mine !== current) {
            return;
          }
          // Stopped for the network (by the platform, before its path event
          // arrived here): a wait, not a failure.
          const waitFor = blockedBy() ?? (needsWifi(error) ? ('wifi' as const) : undefined);
          if (waitFor !== undefined) {
            set({ files: { for: waitFor, kind: 'waiting', progress: progressOf(state.files) } });
            return;
          }
          if (port.active !== undefined && !port.active()) {
            paused = true;
            return;
          }
          set({ files: { kind: 'failed', message: messageOf(error) } });
        },
      )
      .finally(() => {
        if (mine === current) {
          running = undefined;
        }
      });
    return running;
  };

  /** The download, now or once the network allows it. */
  const begin = (): Promise<void> => {
    watch();
    const waitFor = blockedBy();
    if (waitFor !== undefined) {
      set({ files: { for: waitFor, kind: 'waiting', progress: progressOf(state.files) } });
      return Promise.resolve();
    }
    return run();
  };

  const stop = () => {
    if (running !== undefined) {
      current += 1;
      running = undefined;
      port.cancel();
    }
  };

  /** Follows the network while a download is asked for: waits, or goes on. */
  const watch = () => {
    if (watching !== undefined || port.network === undefined) {
      return;
    }
    watching = port.network.subscribe(() => {
      if (choice.download === undefined || state.files.kind === 'ready') {
        return;
      }
      const waitFor = blockedBy();
      if (waitFor !== undefined && state.files.kind === 'downloading') {
        stop();
        set({ files: { for: waitFor, kind: 'waiting', progress: progressOf(state.files) } });
      } else if (waitFor === undefined && state.files.kind === 'waiting') {
        void run();
      } else if (
        waitFor !== undefined &&
        state.files.kind === 'waiting' &&
        state.files.for !== waitFor
      ) {
        // Online now, on mobile data: it waits for Wi-Fi, and mobile data can be allowed.
        set({ files: { ...state.files, for: waitFor } });
      }
    });
  };

  return {
    allowMobileData: async () => {
      await remember({ ...choice, download: 'any' });
      if (state.files.kind !== 'ready') {
        await begin();
      }
    },
    boot: async () => {
      choice = (await port.readChoice().catch(() => undefined)) ?? PARAKEET_DEFAULT;
      set({ on: choice.on });
      const found = await port.files().catch(() => ({ bytes: 0, here: false }));
      if (found.here) {
        set({ files: { bytes: found.bytes, kind: 'ready' } });
      } else if (choice.download !== undefined && choice.on) {
        // Asked for and not here: an unfinished download, or a purged cache.
        void begin();
      }
      await apply();
    },
    download: async (network) => {
      await remember({ download: network, on: true });
      set({ on: true });
      if (state.files.kind !== 'ready') {
        await begin();
      }
    },
    getState: () => state,
    network: () => port.network?.path(),
    remove: async () => {
      stop();
      await remember({ on: choice.on });
      await port.remove().catch(() => undefined);
      set({ files: { kind: 'absent' } });
      await apply();
    },
    resume: () => {
      if (paused && choice.download !== undefined) {
        void begin();
      }
    },
    retry: async () => {
      if (choice.download !== undefined) {
        await begin();
      }
    },
    setOn: async (on) => {
      if (!on) {
        stop();
        await remember({ on: false });
        if (state.files.kind !== 'ready') {
          set({ files: { kind: 'absent' } });
        }
      } else {
        await remember({ ...choice, on: true });
      }
      set({ on });
      await apply();
    },
    subscribe,
    vocabulary: async (next, nextPeople = []) => {
      terms = next;
      people = nextPeople;
      await apply();
      // The load runs while the phrase is said, not at launch.
      if (readsWithParakeet(state)) {
        await port.prepare?.().catch(() => undefined);
      }
    },
  };
};
