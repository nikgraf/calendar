import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/** The level the fake recorder reports, in dBFS; the test moves it. */
let metering = -60;
const transcribe = vi.fn(async () => ({ segments: [{ text: 'Lunch with Anna' }] }));
const deleted: Array<string> = [];

/**
 * The adapter loads its native modules with a lazy `require` (see
 * `load`), which module mocks never see: the test puts the fakes in
 * Node's require cache instead, under the files those names resolve to.
 */
const modules: Record<string, unknown> = {
  '@react-native-ai/apple': {
    AppleTranscription: { prepare: async () => undefined, transcribe },
  },
  'expo-audio': {
    AudioModule: {
      AudioRecorder: class {
        getStatus = () => ({ metering });
        getURI = () => 'file:///recording.wav';
        record = () => undefined;
        stop = async () => undefined;
      },
    },
    requestRecordingPermissionsAsync: async () => ({ granted: true }),
    setAudioModeAsync: async () => undefined,
  },
  'expo-file-system': {
    File: class {
      constructor(readonly uri: string) {}
      arrayBuffer = async () => new ArrayBuffer(8);
      delete = () => {
        deleted.push(this.uri);
      };
    },
  },
};

const nodeRequire = createRequire(new URL('appleSpeech.ts', import.meta.url));
const faked = Object.entries(modules).map(([id, exports]) => {
  const filename = nodeRequire.resolve(id);
  nodeRequire.cache[filename] = { exports, filename, id: filename, loaded: true } as NodeJS.Module;
  return filename;
});

// appleSpeech.test.ts is the build without the native modules.
afterAll(() => {
  for (const filename of faked) {
    delete nodeRequire.cache[filename];
  }
});

beforeEach(() => {
  vi.useFakeTimers();
  metering = -60;
  transcribe.mockClear();
  deleted.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('appleSpeech hands-free listening', () => {
  it('hears the phrase start and end in the recorder level', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    const events: Array<string> = [];
    await appleSpeech.startRecording({ onSpeech: (event) => events.push(event) });
    await vi.advanceTimersByTimeAsync(1000);
    metering = -20;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(['start']);
    metering = -60;
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual(['start']);
    await vi.advanceTimersByTimeAsync(500);
    expect(events).toEqual(['start', 'end']);

    expect(await appleSpeech.stopRecording()).toBe('Lunch with Anna');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(['file:///recording.wav']);
  });

  it('reports nothing when nobody spoke; a stop still transcribes, then deletes the audio', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    const events: Array<string> = [];
    await appleSpeech.startRecording({ onSpeech: (event) => events.push(event) });
    await vi.advanceTimersByTimeAsync(3000);
    expect(events).toEqual([]);

    // The level can miss a quiet phrase: a press of the microphone must not lose it.
    expect(await appleSpeech.stopRecording()).toBe('Lunch with Anna');
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(deleted).toEqual(['file:///recording.wav']);
  });

  it('stops reading the level once the recording is cancelled', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    const events: Array<string> = [];
    await appleSpeech.startRecording({ onSpeech: (event) => events.push(event) });
    await vi.advanceTimersByTimeAsync(500);
    await appleSpeech.cancelRecording();
    metering = -20;
    await vi.advanceTimersByTimeAsync(3000);

    expect(events).toEqual([]);
  });

  it('a tap-to-stop recording transcribes whatever it holds', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    await appleSpeech.startRecording();
    await vi.advanceTimersByTimeAsync(500);

    expect(await appleSpeech.stopRecording()).toBe('Lunch with Anna');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });
});
