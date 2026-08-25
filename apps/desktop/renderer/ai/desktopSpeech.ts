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
const WORKLET_SOURCE = `
registerProcessor('pcm-collector', class extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (channel) {
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
});
`;

interface Recording {
  readonly chunks: Array<Float32Array>;
  readonly context: AudioContext;
  readonly stream: MediaStream;
}

let recording: Recording | null = null;

const stopStream = (active: Recording) => {
  for (const track of active.stream.getTracks()) {
    track.stop();
  }
  void active.context.close();
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
      stopStream(recording);
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
      throw new MicrophoneDeniedError('Microphone access was declined.');
    }
    if (!result.prepared) {
      throw new SpeechUnsupportedError('Dictation assets are unavailable.');
    }
  },

  startRecording: async () => {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, sampleRate: SAMPLE_RATE },
      });
    } catch {
      throw new MicrophoneDeniedError('Microphone access was declined.');
    }
    const context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const workletUrl = URL.createObjectURL(
      new Blob([WORKLET_SOURCE], { type: 'application/javascript' }),
    );
    try {
      await context.audioWorklet.addModule(workletUrl);
    } finally {
      URL.revokeObjectURL(workletUrl);
    }
    const source = context.createMediaStreamSource(stream);
    const collector = new AudioWorkletNode(context, 'pcm-collector');
    const chunks: Array<Float32Array> = [];
    collector.port.onmessage = (message: MessageEvent<Float32Array>) => {
      chunks.push(message.data);
    };
    source.connect(collector);
    recording = { chunks, context, stream };
  },

  stopRecording: async () => {
    const active = recording;
    recording = null;
    if (!active) {
      return undefined;
    }
    stopStream(active);
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
