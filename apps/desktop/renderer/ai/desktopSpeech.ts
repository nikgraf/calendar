import {
  heardFromSegments,
  MicrophoneDeniedError,
  type SpeechStart,
  SpeechUnsupportedError,
  type SpeechToText,
} from '@calendar/ai';
import { dictationLocale, noiseReduction, secondLanguage } from './dictationSettings.ts';
import { toPcm16 } from './pcm16.ts';

/** What the helper's recognisers take: 16 kHz mono. */
const SAMPLE_RATE = 16_000;
/** The audio goes to the helper in blocks this long: the worklet's 8 ms ones would flood the pipe. */
const BLOCK_MS = 100;

/**
 * Desktop dictation: the renderer owns the microphone (getUserMedia +
 * an inline AudioWorklet collecting mono PCM) and streams it to the Swift
 * helper as it is recorded; the helper's recognisers send the words back
 * as they are said, and read each phrase whole when it ends, listening on
 * (`read`) or closing the microphone with it (`finish`). Same
 * seam as apps/ios/src/appleSpeech.ts: availability is decided by
 * attempting prepare, and the audio never outlives the phrase.
 */
/**
 * The worklet that collects PCM blocks: public/pcm-collector.worklet.js,
 * next to index.html in the build and at the root on the dev server. A
 * file of the bundle, so the CSP's script-src 'self' covers it — a blob:
 * URL is blocked there.
 */
const WORKLET_URL = new URL('pcm-collector.worklet.js', document.baseURI).href;

interface Listening {
  readonly context: AudioContext;
  /** Sends what is left of the last block. */
  readonly flush: () => void;
  readonly session: number;
  readonly stream: MediaStream;
  readonly unsubscribe: () => void;
}

let listening: Listening | null = null;

const stopStream = (stream: MediaStream, context?: AudioContext) => {
  for (const track of stream.getTracks()) {
    track.stop();
  }
  void context?.close();
};

/** The microphone and the words stop; the session is the caller's to finish or drop. */
const close = (active: Listening) => {
  active.unsubscribe();
  stopStream(active.stream, active.context);
};

const join = (chunks: ReadonlyArray<Float32Array>, length: number): Float32Array => {
  const joined = new Float32Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
};

/**
 * The languages last prepared: a phrase in others (picked in Settings
 * while an editor stayed open) prepares them first, since only preparing
 * installs a language's assets.
 */
let preparedFor: string | undefined;

const prepareIn = async (locale: string, second: string) => {
  const result = await window.calendarBridge.modelPrepareSpeech(locale, second);
  if (result.denied) {
    throw new MicrophoneDeniedError({ message: 'Microphone access was declined.' });
  }
  if (!result.prepared) {
    throw new SpeechUnsupportedError({ message: 'Dictation assets are unavailable.' });
  }
  preparedFor = `${locale} ${second}`;
};

export const desktopSpeech: SpeechToText = {
  cancel: async () => {
    const active = listening;
    listening = null;
    if (active) {
      close(active);
      await window.calendarBridge.modelSpeechCancel(active.session).catch(() => undefined);
    }
  },

  cut: (mark) => {
    if (listening) {
      window.calendarBridge.modelSpeechCut(listening.session, mark);
    }
  },

  finish: async () => {
    const active = listening;
    listening = null;
    if (!active) {
      return undefined;
    }
    active.flush();
    close(active);
    const result = await window.calendarBridge.modelSpeechFinish(active.session);
    return heardFromSegments(result.segments, result.other, result.parakeet?.text);
  },

  isPrepared: () => preparedFor === `${dictationLocale()} ${secondLanguage.get()}`,

  isSupported: async () => {
    // Same reasoning as iOS: readiness flags are false before first use;
    // the helper's own status tells us whether its stack exists at all —
    // not the model provider's, since a served model answers phrases on a
    // Mac whose helper cannot transcribe — and prepare() decides the rest
    // at use time.
    try {
      // The helper runs, and with it SpeechAnalyzer (every macOS the app
      // opens on has it). Apple Intelligence being off does not take
      // dictation away: main answers only whether the binary responded.
      return (await window.calendarBridge.modelHelperStatus()).helper;
    } catch {
      return false;
    }
  },

  prepare: () => prepareIn(dictationLocale(), secondLanguage.get()),

  read: async () => {
    const active = listening;
    if (!active) {
      return undefined;
    }
    // What was recorded up to now is in the reading.
    active.flush();
    const result = await window.calendarBridge.modelSpeechRead(active.session);
    // No mark: the listening is no longer the helper's (dropped, or replaced).
    return result.mark === undefined
      ? undefined
      : {
          heard: heardFromSegments(result.segments, result.other, result.parakeet?.text),
          mark: result.mark,
        };
  },

  start: async ({ onLost, onWords, signal }) => {
    const locale = dictationLocale();
    const second = secondLanguage.get();
    // Before the microphone opens: a language picked meanwhile may take a
    // download, and a start given up during it must leave nothing on.
    if (preparedFor !== `${locale} ${second}`) {
      await prepareIn(locale, second);
    }
    if (signal?.aborted) {
      return undefined;
    }
    let stream: MediaStream;
    // Chromium's own voice processing, as Settings › Dictation asks.
    const processed = noiseReduction.get();
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: processed,
          channelCount: 1,
          echoCancellation: processed,
          noiseSuppression: processed,
          sampleRate: SAMPLE_RATE,
        },
      });
    } catch {
      throw new MicrophoneDeniedError({ message: 'Microphone access was declined.' });
    }
    let context: AudioContext | undefined;
    let started: { readonly session: number; readonly sources: SpeechStart['sources'] } | undefined;
    try {
      if (!signal?.aborted) {
        // Chromium resamples the microphone to the rate asked for here.
        context = new AudioContext({ sampleRate: SAMPLE_RATE });
        await context.audioWorklet.addModule(WORKLET_URL);
        // Given up while the worklet loaded: starting a session now would
        // drop a newer caller's in the helper.
        if (!signal?.aborted) {
          started = await window.calendarBridge.modelSpeechStart(locale, second);
        }
      }
    } catch (error) {
      stopStream(stream, context);
      throw error;
    }
    // Given up while the microphone was being granted: stop this stream
    // and drop this session only. The current one may be a newer caller's.
    if (!context || started === undefined || signal?.aborted) {
      stopStream(stream, context);
      if (started !== undefined) {
        void window.calendarBridge.modelSpeechCancel(started.session).catch(() => undefined);
      }
      return undefined;
    }
    const phrase = started.session;
    const stopWords = window.calendarBridge.onSpeechWords((words) => {
      if (words.session === phrase) {
        onWords(words.source, words.text);
      }
    });
    const stopLost = window.calendarBridge.onSpeechLost((lost) => {
      if (lost.session !== phrase) {
        return;
      }
      // Main dropped it: the microphone goes, and nothing is left to finish.
      const active = listening;
      if (active?.session === phrase) {
        listening = null;
        close(active);
      }
      onLost?.();
    });
    const unsubscribe = () => {
      stopWords();
      stopLost();
    };
    const source = context.createMediaStreamSource(stream);
    const collector = new AudioWorkletNode(context, 'pcm-collector');
    const blockSize = (SAMPLE_RATE * BLOCK_MS) / 1000;
    let block: Array<Float32Array> = [];
    let blockLength = 0;
    const flush = () => {
      if (blockLength > 0) {
        window.calendarBridge.modelSpeechAudio(phrase, toPcm16(join(block, blockLength)));
      }
      block = [];
      blockLength = 0;
    };
    collector.port.onmessage = (message: MessageEvent<Float32Array>) => {
      block.push(message.data);
      blockLength += message.data.length;
      if (blockLength >= blockSize) {
        flush();
      }
    };
    source.connect(collector);
    // One phrase at a time: replacing one without stopping it would leave
    // that microphone stream on for good.
    const replaced = listening;
    listening = { context, flush, session: phrase, stream, unsubscribe };
    if (replaced) {
      close(replaced);
      void window.calendarBridge.modelSpeechCancel(replaced.session).catch(() => undefined);
    }
    return { sources: started.sources };
  },
};
