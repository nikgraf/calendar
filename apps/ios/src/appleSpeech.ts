import {
  MicrophoneDeniedError,
  SpeechUnsupportedError,
  transcriptFromSegments,
  type SpeechToText,
} from '@calendar/ai';

/**
 * Linear PCM in a .wav container rather than the m4a preset: the
 * transcription API writes the bytes to an extension-less temp file and
 * opens them with AVAudioFile, so the container must be recognisable from
 * its header alone.
 */
const RECORDING_OPTIONS = {
  bitRate: 256_000,
  extension: '.wav',
  ios: {
    audioQuality: 96,
    linearPCMBitDepth: 16,
    linearPCMIsBigEndian: false,
    linearPCMIsFloat: false,
    outputFormat: 'lpcm',
  },
  numberOfChannels: 1,
  sampleRate: 16_000,
};

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
let recorder:
  | { getURI?: () => string | null; record: () => void; stop: () => Promise<void> }
  | undefined;
let recordingUri: string | undefined;

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
    const modules = load();
    if (!modules || !recorder) {
      return;
    }
    try {
      await recorder.stop();
    } catch {
      // Stopping a dead recorder is not worth reporting.
    } finally {
      discard(modules.files, recordingUri ?? recorder.getURI?.() ?? undefined);
      recorder = undefined;
      recordingUri = undefined;
      releaseSession(modules.audio);
    }
  },
  isSupported: async () => load() !== undefined,
  prepare: async () => {
    const modules = load();
    if (!modules) {
      throw new SpeechUnsupportedError('Speech recognition is not built into this app.');
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
        throw new SpeechUnsupportedError(message);
      }
      throw error;
    }
  },
  startRecording: async () => {
    const modules = load();
    if (!modules) {
      throw new SpeechUnsupportedError('Speech recognition is not built into this app.');
    }
    const permission = await modules.audio.requestRecordingPermissionsAsync();
    if (!permission.granted) {
      throw new MicrophoneDeniedError('Microphone access was declined.');
    }
    await modules.audio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
    const instance = new (
      modules.audio as unknown as {
        AudioModule: { AudioRecorder: new (options: unknown) => typeof recorder };
      }
    ).AudioModule.AudioRecorder(RECORDING_OPTIONS) as NonNullable<typeof recorder>;
    recorder = instance;
    recordingUri = undefined;
    instance.record();
  },
  stopRecording: async () => {
    const modules = load();
    if (!modules || !recorder) {
      return undefined;
    }
    const instance = recorder;
    recorder = undefined;
    let uri: string | undefined;
    try {
      await instance.stop();
      uri = instance.getURI?.() ?? undefined;
      recordingUri = uri;
      if (!uri) {
        return undefined;
      }
      const audio = await new modules.files.File(uri).arrayBuffer();
      const result = await modules.speech.AppleTranscription.transcribe(audio, locale());
      return transcriptFromSegments(result.segments);
    } finally {
      // Runs however this ended, so audio never lingers on disk.
      discard(modules.files, uri);
      recordingUri = undefined;
      releaseSession(modules.audio);
    }
  },
};
