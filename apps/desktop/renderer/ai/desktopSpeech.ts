import {
  MicrophoneDeniedError,
  SpeechUnsupportedError,
  transcriptFromSegments,
  type SpeechToText,
} from '@calendar/ai';
import { encodeWav } from './wavEncoder.ts';

const SAMPLE_RATE = 16_000;

/**
 * Desktop dictation: the renderer owns the microphone (getUserMedia +
 * an inline AudioWorklet collecting mono PCM), the Swift helper owns
 * transcription (SpeechAnalyzer, macOS 26). Same seam and philosophy as
 * apps/ios/src/appleSpeech.ts: availability is decided by attempting
 * prepare, and the audio never outlives the request.
 */
/**
 * The worklet that collects PCM blocks: public/pcm-collector.worklet.js,
 * next to index.html in the build and at the root on the dev server. A
 * file of the bundle, so the CSP's script-src 'self' covers it — a blob:
 * URL is blocked there.
 */
const WORKLET_URL = new URL('pcm-collector.worklet.js', document.baseURI).href;

interface Recording {
  readonly chunks: Array<Float32Array>;
  readonly context: AudioContext;
  readonly stream: MediaStream;
}

let recording: Recording | null = null;

const stopStream = (stream: MediaStream, context?: AudioContext) => {
  for (const track of stream.getTracks()) {
    track.stop();
  }
  void context?.close();
};

const collectSamples = (chunks: ReadonlyArray<Float32Array>): Float32Array => {
  const total = chunks.reduce((length, chunk) => length + chunk.length, 0);
  const joined = new Float32Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const CHUNK = 0x80_00;
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
};

export const desktopSpeech: SpeechToText = {
  cancelRecording: async () => {
    if (recording) {
      stopStream(recording.stream, recording.context);
      recording = null;
    }
  },

  isSupported: async () => {
    // Same reasoning as iOS: readiness flags are false before first use;
    // status tells us whether the helper generation stack exists at all,
    // and prepare() decides the rest at use time.
    try {
      const result = await window.calendarBridge.modelStatus();
      return result.status === 'ready';
    } catch {
      return false;
    }
  },

  prepare: async () => {
    const result = await window.calendarBridge.modelPrepareSpeech(navigator.language || 'en-US');
    if (result.denied) {
      throw new MicrophoneDeniedError({ message: 'Microphone access was declined.' });
    }
    if (!result.prepared) {
      throw new SpeechUnsupportedError({ message: 'Dictation assets are unavailable.' });
    }
  },

  startRecording: async ({ signal } = {}) => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: SAMPLE_RATE },
      });
    } catch {
      throw new MicrophoneDeniedError({ message: 'Microphone access was declined.' });
    }
    let context: AudioContext | undefined;
    try {
      if (!signal?.aborted) {
        context = new AudioContext({ sampleRate: SAMPLE_RATE });
        await context.audioWorklet.addModule(WORKLET_URL);
      }
    } catch (error) {
      stopStream(stream, context);
      throw error;
    }
    // Given up while the microphone was being granted: stop this stream
    // only. The current recording may already be a newer caller's.
    if (!context || signal?.aborted) {
      stopStream(stream, context);
      return;
    }
    const source = context.createMediaStreamSource(stream);
    const collector = new AudioWorkletNode(context, 'pcm-collector');
    const chunks: Array<Float32Array> = [];
    collector.port.onmessage = (message: MessageEvent<Float32Array>) => {
      chunks.push(message.data);
    };
    source.connect(collector);
    // One recording at a time: replacing one without stopping it would
    // leave that microphone stream on for good.
    if (recording) {
      stopStream(recording.stream, recording.context);
    }
    recording = { chunks, context, stream };
  },

  stopRecording: async () => {
    const active = recording;
    recording = null;
    if (!active) {
      return undefined;
    }
    stopStream(active.stream, active.context);
    const samples = collectSamples(active.chunks);
    if (samples.length === 0) {
      return undefined;
    }
    const wav = encodeWav(samples, active.context.sampleRate || SAMPLE_RATE);
    const result = await window.calendarBridge.modelTranscribe(
      toBase64(wav),
      navigator.language || 'en-US',
    );
    return transcriptFromSegments(result.segments);
  },
};
