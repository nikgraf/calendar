import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

interface FakeStream {
  readonly getTracks: () => ReadonlyArray<{ readonly stop: () => void }>;
  stopped: boolean;
}

const fakeStream = (): FakeStream => {
  const stream: FakeStream = {
    getTracks: () => [
      {
        stop: () => {
          stream.stopped = true;
        },
      },
    ],
    stopped: false,
  };
  return stream;
};

/** Each pending microphone request, granted by the test in any order. */
const grants: Array<(stream: FakeStream) => void> = [];
/** Each worklet node created, for the test to post blocks through. */
const nodes: Array<{ port: { onmessage: ((message: { data: Float32Array }) => void) | null } }> =
  [];
let addModule: () => Promise<void> = async () => undefined;

const loadSpeech = async () => {
  vi.resetModules();
  return (await import('./desktopSpeech.ts')).desktopSpeech;
};

beforeEach(() => {
  vi.stubGlobal('document', { baseURI: 'file:///app/index.html' });
  vi.stubGlobal('navigator', {
    language: 'en-US',
    mediaDevices: {
      getUserMedia: () => new Promise<FakeStream>((resolve) => grants.push(resolve)),
    },
  });
  vi.stubGlobal(
    'AudioContext',
    class {
      audioWorklet = { addModule: () => addModule() };
      close = async () => undefined;
      createMediaStreamSource = () => ({ connect: () => undefined });
      sampleRate = 16_000;
    },
  );
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      port = { onmessage: null };
      constructor() {
        nodes.push(this);
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  grants.length = 0;
  nodes.length = 0;
  addModule = async () => undefined;
});

describe('desktopSpeech recording ownership', () => {
  it('a start given up while the microphone is granted stops only its own stream', async () => {
    const speech = await loadSpeech();
    // ⌘K closed while the first bar waited for the microphone, then reopened.
    const closed = new AbortController();
    const first = speech.startRecording({ signal: closed.signal });
    closed.abort();
    const second = speech.startRecording();
    const current = fakeStream();
    const late = fakeStream();
    grants[1]?.(current);
    await second;
    grants[0]?.(late);
    await first;

    expect(late.stopped).toBe(true);
    expect(current.stopped).toBe(false);
    await speech.cancelRecording();
    expect(current.stopped).toBe(true);
  });

  it('a newer recording stops the one it replaces', async () => {
    const speech = await loadSpeech();
    const first = speech.startRecording();
    const second = speech.startRecording();
    const older = fakeStream();
    const newer = fakeStream();
    grants[0]?.(older);
    await first;
    grants[1]?.(newer);
    await second;

    expect(older.stopped).toBe(true);
    expect(newer.stopped).toBe(false);
    await speech.cancelRecording();
    expect(newer.stopped).toBe(true);
  });

  it('releases the microphone when the worklet fails to load', async () => {
    const speech = await loadSpeech();
    addModule = async () => {
      throw new Error('worklet blocked');
    };
    const start = speech.startRecording();
    const stream = fakeStream();
    grants[0]?.(stream);

    await expect(start).rejects.toThrow('worklet blocked');
    expect(stream.stopped).toBe(true);
  });
});

/** Posts `ms` of audio at this amplitude through the worklet, in its 128-sample blocks. */
const post = (amplitude: number, ms: number) => {
  const node = nodes.at(-1);
  for (let sample = 0; sample < (16_000 * ms) / 1000; sample += 128) {
    node?.port.onmessage?.({ data: new Float32Array(128).fill(amplitude) });
  }
};

describe('desktopSpeech hands-free listening', () => {
  const transcribe = vi.fn(async () => ({ segments: [{ text: 'Lunch with Anna' }] }));

  beforeEach(() => {
    transcribe.mockClear();
    vi.stubGlobal('window', { calendarBridge: { modelTranscribe: transcribe } });
  });

  it('reports the phrase starting and ending from the level alone', async () => {
    const speech = await loadSpeech();
    const events: Array<string> = [];
    const start = speech.startRecording({ onSpeech: (event) => events.push(event) });
    grants[0]?.(fakeStream());
    await start;
    // A quiet room (-60 dBFS), a phrase (-20 dBFS), then quiet again.
    post(0.001, 1000);
    expect(events).toEqual([]);
    post(0.1, 1000);
    expect(events).toEqual(['start']);
    post(0.001, 1000);
    expect(events).toEqual(['start']);
    post(0.001, 500);
    expect(events).toEqual(['start', 'end']);

    expect(await speech.stopRecording()).toBe('Lunch with Anna');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('reports nothing when nobody spoke, and a stop still transcribes what it holds', async () => {
    const speech = await loadSpeech();
    const events: Array<string> = [];
    const start = speech.startRecording({ onSpeech: (event) => events.push(event) });
    const stream = fakeStream();
    grants[0]?.(stream);
    await start;
    post(0.001, 3000);
    expect(events).toEqual([]);

    // The level can miss a quiet phrase: a press of the microphone must not lose it.
    expect(await speech.stopRecording()).toBe('Lunch with Anna');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(stream.stopped).toBe(true);
  });

  it('a tap-to-stop recording transcribes whatever it holds', async () => {
    const speech = await loadSpeech();
    const start = speech.startRecording();
    grants[0]?.(fakeStream());
    await start;
    post(0.001, 500);

    expect(await speech.stopRecording()).toBe('Lunch with Anna');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});

/** `isSupported` with the helper answering this status. */
const supportedWith = async (status: {
  readonly detail?: string;
  readonly helper: boolean;
  readonly status: string;
}) => {
  vi.stubGlobal('window', { calendarBridge: { modelHelperStatus: async () => status } });
  return (await loadSpeech()).isSupported();
};

describe('desktopSpeech availability', () => {
  it('needs the helper and the OS, not Apple Intelligence', async () => {
    expect(await supportedWith({ helper: true, status: 'ready' })).toBe(true);
    // Apple Intelligence off or its model still downloading: SpeechAnalyzer transcribes anyway.
    expect(
      await supportedWith({ detail: 'deviceNotEligible', helper: true, status: 'unavailable' }),
    ).toBe(true);
    expect(
      await supportedWith({ detail: 'modelNotReady', helper: true, status: 'unavailable' }),
    ).toBe(true);
    expect(await supportedWith({ detail: 'osTooOld', helper: true, status: 'unavailable' })).toBe(
      false,
    );
    expect(
      await supportedWith({ detail: 'helperUnavailable', helper: false, status: 'unavailable' }),
    ).toBe(false);
  });
});
