/**
 * The Assistant's own model, as both apps fetch and describe it: a
 * Qwen3.5 0.8B trained for the tuned path (`tuned.ts`), one GGUF file
 * (Q8_0) published on GitHub (`nikgraf/calendar-models`, its README says
 * how it was made and from what). Each device downloads it once, after
 * the person asks for it (the Create lesson, the Assistant's notice), and
 * checks it by size and SHA-256 before it is loaded. A new version is a
 * new release: the version changes, and it starts unasked (todo.md: how
 * it reaches someone who had the last one).
 */
export interface AssistantModelManifest {
  readonly bytes: number;
  /** The file's name on the device. */
  readonly file: string;
  readonly sha256: string;
  readonly url: string;
  readonly version: string;
}

/** Release v1 of `nikgraf/calendar-models`. */
export const PUBLISHED_MODEL: AssistantModelManifest = {
  bytes: 833_592_288,
  file: 'solunivo-assistant-q8_0.gguf',
  sha256: '954ca95027feb405e2f98ef26fdeb0814d2fdbf4bd2ebddbeb9e9c321ba838d3',
  url: 'https://github.com/nikgraf/calendar-models/releases/download/v1/solunivo-assistant-q8_0.gguf',
  version: 'v1',
};

const isManifest = (value: unknown): value is AssistantModelManifest => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record['bytes'] === 'number' &&
    typeof record['file'] === 'string' &&
    typeof record['sha256'] === 'string' &&
    typeof record['url'] === 'string' &&
    typeof record['version'] === 'string'
  );
};

/**
 * The model a device fetches: an override (a JSON manifest, for a file
 * served from the Mac to a dev build, the simulator or a run from source)
 * when it is set and valid, else the published one.
 */
export const assistantModelManifest = (
  override: string | undefined,
  published: AssistantModelManifest = PUBLISHED_MODEL,
): AssistantModelManifest => {
  if (override?.trim()) {
    try {
      const parsed: unknown = JSON.parse(override);
      if (isManifest(parsed)) {
        return parsed;
      }
    } catch {
      // Not JSON: the published model stands.
    }
  }
  return published;
};

/**
 * The model's name on a device, its version in front: a release that keeps
 * the file's name ("solunivo-assistant-q8_0.gguf") never finds the last
 * one's file in its place, and a device can tell another version's files
 * from its own.
 */
export const storedFileName = (manifest: AssistantModelManifest): string =>
  `${manifest.version.replaceAll(/[^\w.-]/gu, '_')}-${manifest.file}`;

/** The size as a person reads it: "834 MB". */
export const sizeLabel = (bytes: number): string =>
  bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${String(Math.round(bytes / 1e6))} MB`;

/**
 * Why this build or device has no Assistant model: the fixture model
 * runs (e2e), the runtime is switched off (desktop e2e), a simulator
 * without a file to fetch, no llama runtime in the binary, an iPhone with
 * too little memory, or a binary without the download or file module.
 */
export type UnsupportedReason = 'fixture' | 'memory' | 'module' | 'off' | 'runtime' | 'simulator';

/**
 * Where the Assistant's model stands on a device, one state at a time.
 * Nothing is fetched before the person agrees. A file is used once its
 * size and SHA-256 match the manifest. Only the iPhone waits for a network
 * (Wi-Fi without Low Data Mode, unless mobile data was allowed).
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

/** The iPhone's network as the question and the notice word it. */
export interface NetworkReading {
  readonly constrained: boolean;
  readonly expensive: boolean;
  readonly satisfied: boolean;
}

/** The status the Assistant's model reports to the thread: ready only with a checked file. */
export const statusOf = (state: AssistantModelState): 'not-ready' | 'ready' | 'unsupported' =>
  state.kind === 'ready' ? 'ready' : state.kind === 'unsupported' ? 'unsupported' : 'not-ready';

export type AssistantDevice = 'iPhone' | 'Mac';

const UNSUPPORTED: Readonly<Record<AssistantDevice, Readonly<Record<UnsupportedReason, string>>>> =
  {
    iPhone: {
      fixture: 'The Assistant runs on the test model in this build.',
      memory: 'The Assistant needs an iPhone with 8 GB of memory. The form still makes an event.',
      module: 'This build cannot download the Assistant’s model; the next TestFlight build can.',
      off: 'The Assistant’s model is switched off in this build. The form still makes an event.',
      runtime: 'This build cannot run the Assistant’s model; the next TestFlight build can.',
      simulator: 'The simulator downloads the Assistant’s model only from a file it is pointed at.',
    },
    Mac: {
      fixture: 'The Assistant runs on the test model in this build.',
      memory: 'The Assistant needs a Mac with 8 GB of memory. The form still makes an event.',
      module: 'This build cannot download the Assistant’s model.',
      off: 'The Assistant’s model is switched off in this run. The form still makes an event.',
      runtime: 'This build cannot run the Assistant’s model. The form still makes an event.',
      simulator: 'The Assistant’s model is not available here.',
    },
  };

const percentOf = (received: number, total: number): number =>
  total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : 0;

/**
 * What the Assistant's notice (and the device's settings row) says about
 * the model while it is not on the device yet, and the one action each
 * state offers: download, use mobile data (iPhone), or try again.
 */
export const noticeCopy = (
  state: AssistantModelState,
  {
    device,
    network,
    size,
  }: {
    readonly device: AssistantDevice;
    readonly network: NetworkReading | undefined;
    readonly size: number | undefined;
  },
): {
  readonly action?: { readonly kind: 'download' | 'mobile' | 'retry'; readonly label: string };
  readonly lines: ReadonlyArray<string>;
  readonly progress?: number;
} => {
  const sized = size === undefined ? '' : ` (${sizeLabel(size)})`;
  const soon = 'The Assistant will be available soon. You can use the Form meanwhile.';
  switch (state.kind) {
    case 'unasked':
    case 'declined':
      return {
        action: { kind: 'download', label: `Download${sized}` },
        lines: [
          `The Assistant reads what you say with a model that runs on this ${device}. It needs a one-time download${size === undefined ? '' : ` of ${sizeLabel(size)}`}${device === 'iPhone' ? ', over Wi-Fi' : ''}.`,
        ],
      };
    case 'waiting':
      if (state.for === 'network') {
        return { lines: ['Waiting for a connection to download the Assistant’s model.', soon] };
      }
      return network?.expensive === true || network?.constrained !== true
        ? {
            action: { kind: 'mobile', label: `Use Mobile Data${sized}` },
            lines: [`The Assistant’s model downloads when this ${device} is on Wi-Fi.`, soon],
          }
        : {
            action: { kind: 'mobile', label: `Download Now${sized}` },
            lines: ['The Assistant’s model waits while Low Data Mode is on.', soon],
          };
    case 'downloading': {
      const percent = percentOf(state.received, state.total);
      return {
        lines: [`Downloading the Assistant’s model: ${String(percent)} %`, soon],
        progress: percent,
      };
    }
    case 'verifying':
      return { lines: ['Checking the downloaded model…', soon], progress: 100 };
    case 'failed':
      return {
        action: { kind: 'retry', label: 'Try Again' },
        lines: [`The download did not finish: ${state.message}`],
      };
    case 'unsupported':
      return { lines: [UNSUPPORTED[device][state.reason]] };
    case 'ready':
      return { lines: [] };
  }
};

/** A message as a sentence: its own full stop, or one added. */
const sentence = (message: string): string => {
  const trimmed = message.trim();
  return /[.!?…]$/u.test(trimmed) ? trimmed : `${trimmed}.`;
};

/**
 * What the Create lesson says about the model, in its banner, while the
 * model is not on the device yet: what the Assistant is and what the
 * download is, the demo standing in meanwhile, and the notice's one
 * action and progress (`noticeCopy`). Ready, it says the Assistant now
 * takes any words.
 */
export const lessonModelCopy = (
  state: AssistantModelState,
  options: {
    readonly device: AssistantDevice;
    readonly network: NetworkReading | undefined;
    readonly size: number | undefined;
  },
): {
  readonly action?: { readonly kind: 'download' | 'mobile' | 'retry'; readonly label: string };
  readonly progress?: number;
  readonly text: string;
} => {
  const { device, size } = options;
  const { action, progress } = noticeCopy(state, options);
  const meanwhile = 'Meanwhile the demo shows how it works.';
  const text = ((): string => {
    switch (state.kind) {
      case 'unasked':
      case 'declined':
        return `Solunivo reads what you say with an Assistant of its own: a small model trained on calendar phrases, running on this ${device}, so your words stay on it. It is a one-time download${size === undefined ? '' : ` of ${sizeLabel(size)}`}${device === 'iPhone' ? ', over Wi-Fi' : ''}. Until then, the demo below shows how it works.`;
      case 'downloading':
        return `Downloading the Assistant’s model · ${String(progress ?? 0)} %. It goes on if you leave. ${meanwhile}`;
      case 'verifying':
        return `Checking the downloaded model… ${meanwhile}`;
      case 'waiting':
        if (state.for === 'network') {
          return `The Assistant’s model downloads once this ${device} is online. ${meanwhile}`;
        }
        // As the notice tells them apart: on Wi-Fi in Low Data Mode, or on mobile data.
        return options.network?.expensive === true || options.network?.constrained !== true
          ? `The Assistant’s model downloads when this ${device} is on Wi-Fi. ${meanwhile}`
          : `The Assistant’s model waits while Low Data Mode is on. ${meanwhile}`;
      case 'failed':
        return `The download of the Assistant’s model did not finish: ${sentence(state.message)} ${meanwhile}`;
      case 'unsupported':
        return state.reason === 'memory'
          ? `This ${device} can’t run the Assistant’s model: it needs 8 GB of memory. The demo shows what it does; the Form makes your events.`
          : `${UNSUPPORTED[device][state.reason]} The demo shows what the Assistant does.`;
      case 'ready':
        return `The Assistant is ready, on this ${device}. Say it your way now: “make it Thursday”, “an hour later”.`;
    }
  })();
  return {
    ...(action === undefined ? {} : { action }),
    ...(progress === undefined ? {} : { progress }),
    text,
  };
};

/**
 * The Create lesson's row on the Getting started card while the model is
 * not ready: where the download stands, and the demo to try meanwhile.
 * Undefined once it is ready (the row says what it always said).
 */
export const createRowNote = (
  state: AssistantModelState,
  { device }: { readonly device: AssistantDevice },
): { readonly progress?: number; readonly subtitle: string } | undefined => {
  switch (state.kind) {
    case 'unasked':
    case 'declined':
      return { subtitle: 'Try the demo · the Assistant downloads once' };
    case 'downloading': {
      const percent = percentOf(state.received, state.total);
      return { progress: percent, subtitle: `Downloading the Assistant · ${String(percent)} %` };
    }
    case 'verifying':
      return { progress: 100, subtitle: 'Checking the Assistant’s model' };
    case 'waiting':
      return {
        subtitle:
          state.for === 'network'
            ? 'The Assistant downloads once online · try the demo'
            : 'The Assistant downloads on Wi-Fi · try the demo',
      };
    case 'failed':
      return { subtitle: 'The download did not finish · try the demo' };
    case 'unsupported':
      return { subtitle: `See it in a demo · this ${device} uses the Form` };
    case 'ready':
      return undefined;
  }
};
