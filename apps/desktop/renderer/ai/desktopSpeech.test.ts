import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  grants.length = 0;
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
