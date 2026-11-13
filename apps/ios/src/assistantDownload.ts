import type {
  AssistantModelManifest,
  AssistantModelState,
  NetworkReading,
  UnsupportedReason,
} from '@calendar/ai';

/**
 * The Assistant's model on this iPhone (`AssistantModelState`, shared with
 * the Mac in `@calendar/ai`). Nothing is fetched before the person agrees
 * (`agree`, or the Assistant's own Download button); the transfer then goes
 * over Wi-Fi without Low Data Mode only, unless they allowed mobile data. A
 * file is used once its size and SHA-256 match the manifest.
 */

/**
 * The person's answer, kept per model version (a new version starts
 * unasked); "declined" is the old launch question's "Not Now".
 */
export type DownloadAnswer = 'declined' | 'mobile' | 'wifi';

export type TransferNetwork = 'any' | 'wifi';

/** The native transfer (`solunivo-model-download`), as the store uses it. */
export interface TransferPort {
  readonly cancel: (destination: string) => Promise<void>;
  readonly current: () => Promise<
    | { readonly state: 'none' }
    | {
        readonly expected: number;
        readonly network: TransferNetwork;
        readonly received: number;
        readonly state: 'running' | 'suspended';
      }
  >;
  readonly path: () => NetworkReading;
  readonly start: (
    url: string,
    destination: string,
    network: TransferNetwork,
  ) => Promise<{ readonly network: TransferNetwork; readonly started: boolean }>;
  readonly subscribe: (handlers: {
    readonly onFail: (event: { readonly message: string; readonly status: number }) => void;
    readonly onFinish: (event: { readonly path: string }) => void;
    readonly onPath: (event: NetworkReading) => void;
    readonly onProgress: (event: { readonly expected: number; readonly received: number }) => void;
  }) => () => void;
  readonly useNetwork: (network: TransferNetwork) => Promise<boolean>;
}

/** The model's file and the two small notes kept beside it. */
export interface ModelFiles {
  /** The file's URI under the app's caches. */
  readonly destination: string;
  readonly exists: () => boolean;
  readonly readAnswer: () =>
    | { readonly answer: DownloadAnswer; readonly version: string }
    | undefined;
  readonly readVerified: () => { readonly sha256: string; readonly version: string } | undefined;
  readonly remove: () => void;
  readonly sha256: () => Promise<string>;
  readonly size: () => number | undefined;
  readonly writeAnswer: (answer: {
    readonly answer: DownloadAnswer;
    readonly version: string;
  }) => void;
  readonly writeVerified: (verified: { readonly sha256: string; readonly version: string }) => void;
}

export type AssistantDownloadDeps =
  | { readonly reason: UnsupportedReason; readonly supported: false }
  | {
      readonly files: ModelFiles;
      readonly manifest: AssistantModelManifest;
      readonly supported: true;
      readonly transfer: TransferPort;
    };

export interface AssistantDownload {
  /** The person agreed: over Wi-Fi only, or over mobile data too. */
  readonly agree: (network: 'mobile' | 'wifi') => Promise<void>;
  /** Downloading over mobile data too, after the person said so. */
  readonly allowMobileData: () => Promise<void>;
  /** At app start, while it is active: picks up where the last launch left off. */
  readonly boot: () => Promise<void>;
  readonly getState: () => AssistantModelState;
  /** The network now, for the offer's wording. */
  readonly network: () => NetworkReading | undefined;
  readonly retry: () => Promise<void>;
  /** The size to say: the manifest's. */
  readonly size: () => number | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

const MISMATCH = 'The downloaded file was not the model.';

const isMoving = (state: AssistantModelState): boolean =>
  state.kind === 'downloading' || state.kind === 'waiting';

export const createAssistantDownload = (deps: AssistantDownloadDeps): AssistantDownload => {
  const listeners = new Set<() => void>();
  let state: AssistantModelState = deps.supported
    ? { kind: 'unasked' }
    : { kind: 'unsupported', reason: deps.reason };
  let booted = false;
  /** While `boot` waits for the transfer's state: a finish that arrives then is this model's. */
  let booting = false;
  const set = (next: AssistantModelState) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  };
  if (!deps.supported) {
    return {
      agree: async () => undefined,
      allowMobileData: async () => undefined,
      boot: async () => undefined,
      getState: () => state,
      network: () => undefined,
      retry: async () => undefined,
      size: () => undefined,
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
  }
  const { files, manifest, transfer } = deps;
  let path: NetworkReading = transfer.path();
  let progress = { received: 0, total: manifest.bytes };

  const answer = (): DownloadAnswer | undefined => {
    const said = files.readAnswer();
    return said?.version === manifest.version ? said.answer : undefined;
  };
  const networkOf = (): TransferNetwork => (answer() === 'mobile' ? 'any' : 'wifi');

  /** Downloading, or waiting for what the transfer may use. */
  const moving = (): AssistantModelState => {
    if (!path.satisfied) {
      return { for: 'network', kind: 'waiting', ...progress };
    }
    if (networkOf() === 'wifi' && (path.expensive || path.constrained)) {
      return { for: 'wifi', kind: 'waiting', ...progress };
    }
    return { kind: 'downloading', ...progress };
  };

  const verified = (): boolean => {
    const note = files.readVerified();
    return (
      note?.version === manifest.version &&
      note.sha256 === manifest.sha256 &&
      files.exists() &&
      files.size() === manifest.bytes
    );
  };

  const verify = async () => {
    set({ kind: 'verifying' });
    if (files.size() !== manifest.bytes) {
      files.remove();
      set({ kind: 'failed', message: 'The download was incomplete.' });
      return;
    }
    let sha256: string;
    try {
      sha256 = await files.sha256();
    } catch {
      set({ kind: 'failed', message: 'The downloaded file could not be read.' });
      return;
    }
    if (sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
      files.remove();
      // Kept, so the next launch does not fetch the same wrong file by itself.
      files.writeVerified({ sha256, version: manifest.version });
      set({ kind: 'failed', message: MISMATCH });
      return;
    }
    files.writeVerified({ sha256: manifest.sha256, version: manifest.version });
    set({ kind: 'ready', path: files.destination });
  };

  const begin = async () => {
    progress = { received: 0, total: manifest.bytes };
    set(moving());
    try {
      const { network } = await transfer.start(manifest.url, files.destination, networkOf());
      // A transfer already running keeps its rule: moved over where the answer allows more.
      if (network !== networkOf()) {
        await transfer.useNetwork(networkOf());
      }
    } catch (error) {
      set({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  };

  /**
   * A transfer an earlier launch left is kept only where it fetches this
   * file: `start` keeps one of the same address and destination and
   * replaces any other (a file name from before the version was in it,
   * whose finish would never be taken), then the network the answer allows.
   * A transfer that finished after `current` saw it and before `start` looked
   * left its file in place: the one `start` began is not needed, and the
   * file is checked (once, whether its finish is heard first or later).
   */
  const reconcile = async () => {
    try {
      const { network, started } = await transfer.start(
        manifest.url,
        files.destination,
        networkOf(),
      );
      if (started && files.exists()) {
        await transfer.cancel(files.destination).catch(() => undefined);
        if (isMoving(state)) {
          await verify();
        }
        return;
      }
      if (started) {
        progress = { received: 0, total: manifest.bytes };
        if (isMoving(state)) {
          set(moving());
        }
      }
      if (network !== networkOf()) {
        await transfer.useNetwork(networkOf());
      }
    } catch (error) {
      set({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  };

  const handlers = {
    onFail: ({ message }: { readonly message: string }) => {
      set({ kind: 'failed', message });
    },
    onFinish: ({ path }: { readonly path: string }) => {
      // Another version's transfer, or one nobody waits for, is not this model.
      if (path !== files.destination || !(isMoving(state) || booting)) {
        return;
      }
      void verify();
    },
    onPath: (reading: NetworkReading) => {
      path = reading;
      if (isMoving(state)) {
        set(moving());
      }
    },
    onProgress: ({
      expected,
      received,
    }: {
      readonly expected: number;
      readonly received: number;
    }) => {
      progress = { received, total: expected > 0 ? expected : manifest.bytes };
      if (isMoving(state)) {
        set(moving());
      }
    },
  };

  return {
    agree: async (network) => {
      files.writeAnswer({ answer: network, version: manifest.version });
      await begin();
    },
    allowMobileData: async () => {
      files.writeAnswer({ answer: 'mobile', version: manifest.version });
      const moved = await transfer.useNetwork('any').catch(() => false);
      if (moved) {
        set(moving());
        return;
      }
      await begin();
    },
    boot: async () => {
      if (booted) {
        return;
      }
      booted = true;
      transfer.subscribe(handlers);
      path = transfer.path();
      if (verified()) {
        set({ kind: 'ready', path: files.destination });
        return;
      }
      const said = answer();
      if (said === undefined || said === 'declined') {
        // A transfer of another version, or one declined since, goes.
        await transfer.cancel(files.destination).catch(() => undefined);
        set({ kind: said === undefined ? 'unasked' : 'declined' });
        return;
      }
      booting = true;
      const running = await transfer.current().finally(() => {
        booting = false;
      });
      // Finished while the state was read: the check is already under way.
      if (state.kind === 'verifying' || state.kind === 'ready' || state.kind === 'failed') {
        return;
      }
      if (running.state !== 'none') {
        progress = {
          received: running.received,
          total: running.expected > 0 ? running.expected : manifest.bytes,
        };
        set(moving());
        await reconcile();
        return;
      }
      // Finished while the app was not running: the delegate moved it into place.
      if (files.exists()) {
        await verify();
        return;
      }
      // The last file was the wrong one: Try Again fetches it once more, not every launch.
      const note = files.readVerified();
      if (note?.version === manifest.version && note.sha256 !== manifest.sha256) {
        set({ kind: 'failed', message: MISMATCH });
        return;
      }
      await begin();
    },
    getState: () => state,
    network: () => path,
    retry: begin,
    size: () => manifest.bytes,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
