import {
  createEndpointer,
  MicrophoneDeniedError,
  SpeechUnsupportedError,
  transcriptFromSegments,
  type SpeechToText,
} from '@calendar/ai';
// A type only: erased, so it never loads the native module (see `load`).
import type { AudioRecorder } from 'expo-audio';

/**
 * Linear PCM in a .wav container rather than the m4a preset: the
 * transcription API writes the bytes to an extension-less temp file and
 * opens them with AVAudioFile, so the container must be recognisable from
 * its header alone. Metering gives hands-free listening the level
 * (`getStatus().metering`, dBFS) it hears a pause in.
 *
 * Flat, not under an `ios` key: that nesting is `useAudioRecorder`'s
 * input, which the hook flattens before the native constructor sees it.
 * Handed to the constructor as is, the format keys under `ios` are
 * dropped.
 */
const RECORDING_OPTIONS = {
  /** AVAudioQuality.high. */
  audioQuality: 96,
  bitRate: 256_000,
  extension: '.wav',
  isMeteringEnabled: true,
  linearPCMBitDepth: 16,
  linearPCMIsBigEndian: false,
  linearPCMIsFloat: false,
  numberOfChannels: 1,
  outputFormat: 'lpcm',
  sampleRate: 16_000,
};

/** How often hands-free listening reads the recorder's level. */
const LEVEL_POLL_MS = 50;

/** Locale for recognition, so dictating German transcribes German. */
const locale = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en-US';
  } catch {
    return 'en-US';
  }
};

/**
 * Every native module used here is loaded lazily and inside a try. Both
 * `@react-native-ai/apple` and `expo-audio` resolve their native modules
 * at *module scope* and throw when the pod is missing, so a static import
 * anywhere reachable from the app root crashes the whole app at launch on
 * a binary built before this feature — which is exactly what an OTA
 * preview does. Nothing here may be imported statically.
 */
const load = () => {
  try {
    /* eslint-disable typescript/no-require-imports -- deliberate: see above */
    return {
      audio: require('expo-audio') as typeof import('expo-audio'),
      files: require('expo-file-system') as typeof import('expo-file-system'),
      speech: require('@react-native-ai/apple') as typeof import('@react-native-ai/apple'),
    };
    /* eslint-enable typescript/no-require-imports */
  } catch {
    return undefined;
  }
};

/** The in-flight recording, if any, with the file it was started with. */
let recording: { readonly instance: AudioRecorder; readonly uri: string | undefined } | undefined;
/**
 * Starts under way: the session is in record mode for them, and their
 * recorder is not the current one yet.
 */
let starting = 0;
/** Hands-free only: the timer feeding the recording's ear its level. */
let levelPoll: ReturnType<typeof setInterval> | undefined;

const stopListening = () => {
  clearInterval(levelPoll);
  levelPoll = undefined;
};

/**
 * Leaving the session in record mode keeps the microphone indicator lit
 * and routes every later sound as record-capable. Taking it out stops
 * every recorder there is and forbids them to record, so it waits while a
 * recording runs or a start is on its way to one — either may be a newer
 * caller's.
 */
const releaseSessionUnlessBusy = (audio: typeof import('expo-audio')) => {
  if (recording || starting > 0) {
    return;
  }
  void audio.setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
};

/**
 * A recorder that is done with: its audio deleted, its native object
 * released. Released, so nothing wakes it — expo-audio starts every
 * prepared recorder it still knows when the app comes to the foreground.
 * `uri` is the file it was started with: a media-services reset
 * re-prepares a recorder onto a new file, so the one it ends with may
 * differ — both go.
 */
const dispose = (
  files: typeof import('expo-file-system'),
  instance: AudioRecorder,
  uri: string | undefined,
) => {
  // The files first: the properties are gone once released.
  let current: string | undefined;
  try {
    current = instance.uri ?? undefined;
  } catch {
    // Released already.
  }
  for (const path of new Set([uri, current])) {
    if (!path) {
      continue;
    }
    try {
      new files.File(path).delete();
    } catch {
      // Already gone.
    }
  }
  try {
    instance.release();
  } catch {
    // Already released.
  }
};

/**
 * Apple's on-device SpeechAnalyzer, plus the recording that feeds it.
 * Audio never leaves the device and the file is deleted as soon as it is
 * transcribed, abandoned, or fails.
 */
export const appleSpeech: SpeechToText = {
  cancelRecording: async () => {
    stopListening();
    const modules = load();
    const current = recording;
    if (!modules || !current) {
      return;
    }
    // Given up before the stop lands: a start meanwhile is not this one.
    recording = undefined;
    try {
      await current.instance.stop();
    } catch {
      // Stopping a dead recorder is not worth reporting.
    } finally {
      dispose(modules.files, current.instance, current.uri);
      releaseSessionUnlessBusy(modules.audio);
    }
  },
  isSupported: async () => load() !== undefined,
  prepare: async () => {
    const modules = load();
    if (!modules) {
      throw new SpeechUnsupportedError({
        message: 'Speech recognition is not built into this app.',
      });
    }
    try {
      // Installs the locale's models; a no-op once present.
      await modules.speech.AppleTranscription.prepare(locale());
    } catch (error) {
      // Distinguish "this device or locale never will" from "that attempt
      // failed" — installing models needs the network, and a download
      // failure must stay retryable rather than hiding dictation for good.
      const message = String(error);
      if (/not supported|unsupported|unavailable/i.test(message)) {
        throw new SpeechUnsupportedError({ message });
      }
      throw error;
    }
  },
  startRecording: async ({ onSpeech, signal } = {}) => {
    const modules = load();
    if (!modules) {
      throw new SpeechUnsupportedError({
        message: 'Speech recognition is not built into this app.',
      });
    }
    const permission = await modules.audio.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      throw new MicrophoneDeniedError({ message: 'Microphone access was declined.' });
    }
    if (signal?.aborted) {
      return;
    }
    starting += 1;
    let instance: AudioRecorder | undefined;
    let uri: string | undefined;
    let current = false;
    try {
      await modules.audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      // Given up meanwhile: record nothing.
      if (signal?.aborted) {
        return;
      }
      instance = new (
        modules.audio as unknown as {
          AudioModule: { AudioRecorder: new (options: unknown) => AudioRecorder };
        }
      ).AudioModule.AudioRecorder(RECORDING_OPTIONS);
      // The recorder records only once prepared. Unprepared, `record()`
      // returns having started nothing — and the meter of a recorder that
      // is not running reads digital silence, so no pause is ever heard.
      await instance.prepareToRecordAsync();
      uri = instance.uri ?? undefined;
      if (signal?.aborted) {
        return;
      }
      instance.record();
      if (!instance.isRecording) {
        // Said so, rather than a lit microphone over nothing.
        throw new Error('The recorder did not start.');
      }
      recording = { instance, uri };
      current = true;
      stopListening();
      if (onSpeech) {
        const ear = createEndpointer();
        const running = instance;
        levelPoll = setInterval(() => {
          const level = running.getStatus().metering;
          if (level === undefined) {
            return;
          }
          const event = ear.push(level, Date.now());
          if (event) {
            onSpeech(event);
          }
        }, LEVEL_POLL_MS);
      }
    } finally {
      starting -= 1;
      // Never became the recording (given up, failed, or did not start):
      // nothing of it stays behind, and the session is left to whoever
      // else holds it.
      if (instance && !current) {
        dispose(modules.files, instance, uri);
      }
      releaseSessionUnlessBusy(modules.audio);
    }
  },
  stopRecording: async () => {
    stopListening();
    const modules = load();
    const current = recording;
    if (!modules || !current) {
      return undefined;
    }
    recording = undefined;
    const { instance, uri } = current;
    try {
      await instance.stop();
      if (!uri) {
        return undefined;
      }
      const audio = await new modules.files.File(uri).arrayBuffer();
      const result = await modules.speech.AppleTranscription.transcribe(audio, locale());
      return transcriptFromSegments(result.segments);
    } finally {
      // Runs however this ended, so audio never lingers on disk.
      dispose(modules.files, instance, uri);
      releaseSessionUnlessBusy(modules.audio);
    }
  },
};
