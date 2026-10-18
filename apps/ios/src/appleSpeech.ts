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

/** The in-flight recording, if any. */
let recorder: AudioRecorder | undefined;
/** Hands-free only: the timer feeding the recording's ear its level. */
let levelPoll: ReturnType<typeof setInterval> | undefined;

const stopListening = () => {
  clearInterval(levelPoll);
  levelPoll = undefined;
};

const releaseSession = (audio: typeof import('expo-audio')) => {
  // Leaving the session in record mode keeps the microphone indicator lit
  // and routes every later sound as record-capable.
  void audio.setAudioModeAsync({ allowsRecording: false }).catch(() => undefined);
};

const discard = (files: typeof import('expo-file-system'), uri: string | undefined) => {
  if (!uri) {
    return;
  }
  try {
    new files.File(uri).delete();
  } catch {
    // Already gone.
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
    const instance = recorder;
    if (!modules || !instance) {
      return;
    }
    // Given up before the stop lands: a start meanwhile is not this one.
    recorder = undefined;
    try {
      await instance.stop();
    } catch {
      // Stopping a dead recorder is not worth reporting.
    } finally {
      discard(modules.files, instance.uri ?? undefined);
      if (!recorder) {
        releaseSession(modules.audio);
      }
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
    await modules.audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    // Given up meanwhile: record nothing, and leave the session in record
    // mode if a recording is running — it may be a newer caller's.
    if (signal?.aborted) {
      if (!recorder) {
        releaseSession(modules.audio);
      }
      return;
    }
    const instance = new (
      modules.audio as unknown as {
        AudioModule: { AudioRecorder: new (options: unknown) => AudioRecorder };
      }
    ).AudioModule.AudioRecorder(RECORDING_OPTIONS);
    // This recorder never became the recording: nothing of it stays behind.
    const abandon = () => {
      discard(modules.files, instance.uri ?? undefined);
      if (!recorder) {
        releaseSession(modules.audio);
      }
    };
    // The recorder records only once prepared. Unprepared, `record()`
    // returns having started nothing — and the meter of a recorder that is
    // not running reads digital silence, so no pause is ever heard.
    try {
      await instance.prepareToRecordAsync();
    } catch (error) {
      abandon();
      throw error;
    }
    if (signal?.aborted) {
      abandon();
      return;
    }
    instance.record();
    if (!instance.isRecording) {
      // Said so, rather than a lit microphone over nothing.
      abandon();
      throw new Error('The recorder did not start.');
    }
    recorder = instance;
    stopListening();
    if (onSpeech) {
      const ear = createEndpointer();
      levelPoll = setInterval(() => {
        const level = instance.getStatus().metering;
        if (level === undefined) {
          return;
        }
        const event = ear.push(level, Date.now());
        if (event) {
          onSpeech(event);
        }
      }, LEVEL_POLL_MS);
    }
  },
  stopRecording: async () => {
    stopListening();
    const modules = load();
    if (!modules || !recorder) {
      return undefined;
    }
    const instance = recorder;
    recorder = undefined;
    const uri = instance.uri ?? undefined;
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
      discard(modules.files, uri);
      if (!recorder) {
        releaseSession(modules.audio);
      }
    }
  },
};
