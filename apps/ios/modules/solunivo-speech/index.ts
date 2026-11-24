import { requireNativeModule } from 'expo';

/** A recogniser's words so far for one phrase, whenever they change. */
export interface SpeechWordsEvent {
  readonly session: number;
  readonly source: 'accurate' | 'quick';
  readonly text: string;
}

/** iOS's Mic Mode for the app, as the user picked it in Control Center. */
export type MicrophoneMode = 'standard' | 'voiceIsolation' | 'wideSpectrum';

/** A phrase as Parakeet read it: before and after the vocabulary's rescoring. */
export interface ParakeetRead {
  readonly raw: string;
  readonly replacements: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly text: string;
}

/** The Parakeet models the Speech Spike page can load (FluidAudio's names). */
export type ParakeetVersion = 'ultra' | 'v3';

/** One file, as the Speech Spike page's Parakeet heard it. */
export interface ParakeetHeard extends ParakeetRead {
  readonly audioSeconds: number;
  /** Decoding the file, the model and the vocabulary's rescoring, together. */
  readonly ms: number;
  readonly rescoreMs: number;
}

/** A phrase read whole: Apple's segments, and the other readings beside them. */
export interface SpeechRead {
  /** The phrase as the user's other language reads it; absent without one, and on a binary built before it. */
  readonly other?: string;
  /** The phrase as Parakeet read it, when dictation reads with it and it answered in time. */
  readonly parakeet?: ParakeetRead;
  readonly segments: ReadonlyArray<{
    readonly alternatives: ReadonlyArray<string>;
    readonly text: string;
  }>;
}

/**
 * Parakeet's half of the module (packages/ai/swift/ParakeetBridge.swift),
 * absent on a binary built before it.
 */
export interface SolunivoParakeetNative {
  readonly addListener: (
    name: 'onParakeetProgress',
    listener: (event: { readonly fraction: number }) => void,
  ) => { readonly remove: () => void };
  readonly parakeetCancel: () => void;
  /**
   * Fetches what is missing of the files; rejects "cancelled" after
   * `parakeetCancel`, and with the code `ParakeetNeedsWifi` when `wifiOnly`
   * and the path turned expensive or constrained (stopped natively).
   */
  readonly parakeetDownload: (wifiOnly: boolean) => Promise<void>;
  /** As a phrase starts: the models load in the background when dictation reads with Parakeet. */
  readonly parakeetPrepare: () => Promise<void>;
  /** The app left the screen: the models go, the switch stays. */
  readonly parakeetRelieve: () => Promise<void>;
  readonly parakeetRemove: () => Promise<void>;
  readonly parakeetSpikeLoad: (
    version: ParakeetVersion,
    vocabulary: ReadonlyArray<string>,
  ) => Promise<{ readonly loadMs: number }>;
  readonly parakeetSpikeRelease: () => Promise<void>;
  /** A file URI (`file:///…`) of audio AVAudioFile reads. */
  readonly parakeetSpikeTranscribe: (uri: string) => Promise<ParakeetHeard>;
  readonly parakeetState: () => Promise<{ readonly bytes: number; readonly here: boolean }>;
  /** Dictation reads with Parakeet, with these names as its vocabulary, or no longer does. */
  readonly parakeetUse: (on: boolean, vocabulary: ReadonlyArray<string>) => Promise<void>;
}

export interface SolunivoSpeechNative {
  readonly addListener: (
    name: 'onWords',
    listener: (event: SpeechWordsEvent) => void,
  ) => { readonly remove: () => void };
  /** Drops the phrase and closes the microphone; nothing when `session` is not the current one. */
  readonly cancel: (session: number) => Promise<void>;
  /** The phrase read up to `mark` landed: its audio goes, and the next reading begins after it. */
  readonly cut: (session: number, mark: number) => void;
  /**
   * Closes the microphone and reads the phrase whole. Null when `session`
   * is not the current one (dropped, or replaced by a newer start).
   */
  readonly finish: (session: number) => Promise<SpeechRead | null>;
  /**
   * A locale's language in English, the app's own ("German (Austria)"); the
   * id when it has no name. Absent on a binary built before it (a stale
   * local dev client: OTA updates never reach another fingerprint).
   */
  readonly languageName?: (locale: string) => string;
  /**
   * The languages dictation may listen in (BCP 47), and the second language
   * Automatic comes to for `locale`; absent like `languageName`.
   */
  readonly languages?: (
    locale: string,
  ) => Promise<{ readonly automatic?: string; readonly available: ReadonlyArray<string> }>;
  /** The Mic Mode picked for this app (applied only while recording with voice processing); absent like `languageName`. */
  readonly microphoneMode?: () => MicrophoneMode;
  /**
   * Installs the locale's speech assets, and on the side the second
   * language's (`other`: "auto", "off" or a language); rejects with
   * "unsupported: …" where the locale never will.
   */
  readonly prepare: (locale: string, other: string) => Promise<void>;
  /**
   * Reads the phrase so far whole, the microphone left open; `mark` is
   * where its audio ended. Null when `session` is not the current one.
   */
  readonly read: (session: number) => Promise<(SpeechRead & { readonly mark: number }) | null>;
  /** Asks for the microphone if iOS has not yet; whether it may be used. */
  readonly requestMicrophone: () => Promise<boolean>;
  /** Opens the microphone for a phrase; a newer start replaces it. Answers the recognisers that listen. */
  readonly start: (
    session: number,
    locale: string,
    voiceProcessing: boolean,
    other: string,
  ) => Promise<{ readonly sources: ReadonlyArray<'accurate' | 'quick'> }>;
}

/**
 * Loaded lazily: `requireNativeModule` throws on a binary built before this
 * module existed (an OTA update on an older TestFlight build), and a static
 * call at import time would take the whole app down with it.
 */
export const loadSpeechModule = (): SolunivoSpeechNative | undefined => {
  try {
    return requireNativeModule<SolunivoSpeechNative>('SolunivoSpeech');
  } catch {
    return undefined;
  }
};

/** Parakeet's functions, when this binary has them (built after #378). */
export const loadParakeet = (): SolunivoParakeetNative | undefined => {
  const module = loadSpeechModule() as
    | (SolunivoSpeechNative & Partial<SolunivoParakeetNative>)
    | undefined;
  return module?.parakeetState === undefined
    ? undefined
    : (module as unknown as SolunivoParakeetNative);
};
