import { type AssistantDevice, type NetworkReading, sizeLabel } from './assistantModel.ts';

/**
 * Parakeet, as both apps fetch and describe it: NVIDIA's speech recogniser
 * in moondream's post-trained Ultra, FluidAudio's Core ML port
 * (`FluidInference/parakeet-ultra-coreml`), with the CTC model that lets
 * it listen for names (`FluidInference/parakeet-ctc-110m-coreml`), both
 * from Hugging Face at the commits ParakeetBridge.swift pins. Dictation
 * reads each finished phrase with it once it is here and Settings ›
 * Dictation › Read With Parakeet is on (it is from the start); until then,
 * or off, Apple's recogniser alone writes the phrase. Nothing is fetched
 * before the person asks (the Create lesson, Settings › Dictation). Measured
 * on Nik's recordings (#378): English sentences 16 % of words wrong
 * against Apple's 30 %, every listed full name right.
 */

/** Both models together, as the download is offered (613 MB + 99 MB). */
export const PARAKEET_BYTES = 712_000_000;

/**
 * Why this build has no Parakeet: switched off (e2e, `CALENDAR_PARAKEET=off`),
 * or a binary without it (an iOS build from before it, a Mac without the helper).
 */
export type ParakeetUnsupported = 'module' | 'off';

/** Where Parakeet's files stand on a device, one state at a time. */
export type ParakeetFilesState =
  /** Not here and not asked for: the download is offered. */
  | { readonly kind: 'absent' }
  /** `progress`: 0 to 1, over both models. */
  | { readonly kind: 'downloading'; readonly progress: number }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly bytes: number; readonly kind: 'ready' }
  | { readonly kind: 'unsupported'; readonly reason: ParakeetUnsupported }
  | {
      /** What the download waits for: Wi-Fi (on mobile data or in Low Data Mode), or any connection. */
      readonly for: 'network' | 'wifi';
      readonly kind: 'waiting';
      readonly progress: number;
    };

/** Parakeet on a device: the switch, and the files. */
export interface ParakeetState {
  readonly files: ParakeetFilesState;
  /** Settings › Dictation › Read With Parakeet: on from the start. */
  readonly on: boolean;
}

/**
 * What a device keeps about Parakeet between launches: the switch, and
 * that the download was asked for and how (so a launch picks it up, and a
 * purged cache fetches it again).
 */
export interface ParakeetChoice {
  readonly download?: 'any' | 'wifi';
  readonly on: boolean;
}

/** Before anyone chose: on, nothing asked for. */
export const PARAKEET_DEFAULT: ParakeetChoice = { on: true };

/** A stored choice, or the default where there is none or it is unreadable. */
export const readParakeetChoice = (value: unknown): ParakeetChoice => {
  if (typeof value !== 'object' || value === null) {
    return PARAKEET_DEFAULT;
  }
  const record = value as Record<string, unknown>;
  const download = record['download'];
  return {
    ...(download === 'any' || download === 'wifi' ? { download } : {}),
    on: typeof record['on'] === 'boolean' ? record['on'] : PARAKEET_DEFAULT.on,
  };
};

/** Whether dictation reads with Parakeet now: on, and here. */
export const readsWithParakeet = (state: ParakeetState): boolean =>
  state.on && state.files.kind === 'ready';

const percent = (progress: number): number => Math.min(100, Math.floor(progress * 100));

/** The one action a state offers, as a row or a button says it. */
export type ParakeetAction =
  | { readonly kind: 'download'; readonly label: string }
  | { readonly kind: 'mobile'; readonly label: string }
  | { readonly kind: 'retry'; readonly label: string };

/**
 * What Settings › Dictation says about Parakeet's files: one line, the
 * progress while it downloads, and the one action the state offers.
 */
export const parakeetCopy = (
  files: ParakeetFilesState,
  {
    device,
    network,
  }: { readonly device: AssistantDevice; readonly network: NetworkReading | undefined },
): {
  readonly action?: ParakeetAction;
  readonly line: string;
  readonly progress?: number;
} => {
  const size = sizeLabel(PARAKEET_BYTES);
  switch (files.kind) {
    case 'absent':
      return {
        action: { kind: 'download', label: `Download Parakeet (${size})` },
        line: `Not on this ${device} yet. It is a one-time download${device === 'iPhone' ? ', over Wi-Fi' : ''}.`,
      };
    case 'downloading':
      return {
        line: `Downloading Parakeet · ${String(percent(files.progress))} %`,
        progress: percent(files.progress),
      };
    case 'waiting':
      if (files.for === 'network') {
        return { line: 'Waiting for a connection to download Parakeet.' };
      }
      return network?.expensive === true || network?.constrained !== true
        ? {
            action: { kind: 'mobile', label: `Use Mobile Data (${size})` },
            line: `Parakeet downloads when this ${device} is on Wi-Fi.`,
          }
        : {
            action: { kind: 'mobile', label: `Download Now (${size})` },
            line: 'Parakeet waits while Low Data Mode is on.',
          };
    case 'failed':
      return {
        action: { kind: 'retry', label: 'Try Again' },
        line: `The download did not finish: ${files.message}`,
      };
    case 'ready':
      return { line: `On this ${device} · ${sizeLabel(files.bytes)}` };
    case 'unsupported':
      return {
        line:
          files.reason === 'off'
            ? 'Parakeet is switched off in this build.'
            : `This build cannot run Parakeet; dictation uses Apple’s recogniser.`,
      };
  }
};
