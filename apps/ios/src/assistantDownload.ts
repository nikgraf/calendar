import type { AssistantModelManifest } from './assistantModelManifest.ts';

/**
 * Where the Assistant's model stands on this iPhone, one state at a time.
 * Nothing is fetched before the person agrees (`agree`, or the
 * Assistant's own Download button); the transfer then goes over Wi-Fi
 * without Low Data Mode only, unless they allowed mobile data. A file is
 * used once its size and SHA-256 match the manifest.
 */
export type AssistantModelState =
  | { readonly kind: 'declined' }
  | { readonly kind: 'downloading'; readonly received: number; readonly total: number }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'ready'; readonly path: string }
  | { readonly kind: 'unasked' }
  | { readonly kind: 'unsupported'; readonly reason: UnsupportedReason }
  | { readonly kind: 'verifying' }
  | {
      /** What the transfer waits for: Wi-Fi (on mobile data or in Low Data Mode), or any connection. */
      readonly for: 'network' | 'wifi';
      readonly kind: 'waiting';
      readonly received: number;
      readonly total: number;
    };

/**
 * Why this build or device has no Assistant model: the fixture model
 * runs (e2e), a simulator without a file to fetch, no llama runtime in
 * the binary, an iPhone with too little memory, no model published, or a
 * binary without the download module.
 */
export type UnsupportedReason =
  | 'fixture'
  | 'memory'
  | 'module'
  | 'runtime'
  | 'simulator'
  | 'unpublished';

/** The person's answer, kept per model version: a new version asks again. */
export type DownloadAnswer = 'declined' | 'mobile' | 'wifi';

export interface NetworkReading {
  readonly constrained: boolean;
  readonly expensive: boolean;
  readonly satisfied: boolean;
}

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
  readonly decline: () => void;
  readonly getState: () => AssistantModelState;
  /** The network now, for the question's wording. */
  readonly network: () => NetworkReading | undefined;
  readonly retry: () => Promise<void>;
  /** The size to say: the manifest's. */
  readonly size: () => number | undefined;
  readonly subscribe: (listener: () => void) => () => void;
}

const isMoving = (state: AssistantModelState): boolean =>
  state.kind === 'downloading' || state.kind === 'waiting';

export const createAssistantDownload = (deps: AssistantDownloadDeps): AssistantDownload => {
  const listeners = new Set<() => void>();
  let state: AssistantModelState = deps.supported
    ? { kind: 'unasked' }
    : { kind: 'unsupported', reason: deps.reason };
  let booted = false;
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
      decline: () => undefined,
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
      set({ kind: 'failed', message: 'The downloaded file was not the model.' });
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

  const handlers = {
    onFail: ({ message }: { readonly message: string }) => {
      set({ kind: 'failed', message });
    },
    onFinish: () => {
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
      if (said === undefined) {
        set({ kind: 'unasked' });
        return;
      }
      if (said === 'declined') {
        set({ kind: 'declined' });
        return;
      }
      const running = await transfer.current();
      if (running.state !== 'none') {
        progress = {
          received: running.received,
          total: running.expected > 0 ? running.expected : manifest.bytes,
        };
        set(moving());
        if (running.network !== networkOf()) {
          await transfer.useNetwork(networkOf());
        }
        return;
      }
      // Finished while the app was not running: the delegate moved it into place.
      if (files.exists()) {
        await verify();
        return;
      }
      await begin();
    },
    decline: () => {
      files.writeAnswer({ answer: 'declined', version: manifest.version });
      set({ kind: 'declined' });
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

/** The status the Assistant's model reports to the thread: ready only with a checked file. */
export const statusOf = (state: AssistantModelState): 'not-ready' | 'ready' | 'unsupported' =>
  state.kind === 'ready' ? 'ready' : state.kind === 'unsupported' ? 'unsupported' : 'not-ready';
