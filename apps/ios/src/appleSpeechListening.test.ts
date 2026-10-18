import type { AudioRecorder, RecorderState } from 'expo-audio';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

/** The level the fake recorder reports while it records, in dBFS; the test moves it. */
let metering = -60;
/** Whether `record()` starts the recorder: off for the test of one that does not. */
let starts = true;
/** Runs inside `prepareToRecordAsync`: a test gives a start up from here. */
let whilePreparing: (() => void) | undefined;
const transcribe = vi.fn(async () => ({ segments: [{ text: 'Lunch with Anna' }] }));
const deleted: Array<string> = [];
/** The options each recorder was constructed with. */
const constructed: Array<Record<string, unknown>> = [];
/** Every `setAudioModeAsync` call's `allowsRecording`. */
const audioModes: Array<boolean> = [];

/**
 * expo-audio 57's recorder, as far as the adapter drives it: it records
 * only once prepared (unprepared, `record()` starts nothing), its file is
 * the `uri` property, and the meter of a recorder that is not running
 * reads digital silence.
 */
class FakeRecorder implements Pick<
  AudioRecorder,
  'getStatus' | 'isRecording' | 'prepareToRecordAsync' | 'record' | 'stop' | 'uri'
> {
  isRecording = false;
  prepared = false;
  readonly uri = 'file:///recording.wav';

  constructor(options: Record<string, unknown>) {
    constructed.push(options);
  }

  getStatus = (): RecorderState => ({
    canRecord: this.prepared,
    durationMillis: 0,
    isRecording: this.isRecording,
    mediaServicesDidReset: false,
    metering: this.isRecording ? metering : -160,
    url: this.uri,
  });

  prepareToRecordAsync = async () => {
    this.prepared = true;
    whilePreparing?.();
  };

  record = () => {
    if (this.prepared && starts) {
      this.isRecording = true;
    }
  };

  stop = async () => {
    this.isRecording = false;
  };
}

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
    AudioModule: { AudioRecorder: FakeRecorder },
    requestRecordingPermissionsAsync: async () => ({ granted: true }),
    setAudioModeAsync: async ({ allowsRecording }: { allowsRecording: boolean }) => {
      audioModes.push(allowsRecording);
    },
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
  starts = true;
  whilePreparing = undefined;
  transcribe.mockClear();
  deleted.length = 0;
  constructed.length = 0;
  audioModes.length = 0;
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

  it('hands the recorder its options flat, and prepares it before it records', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    await appleSpeech.startRecording();
    // The format keys at the top level, where the native constructor reads
    // them; under `ios` they would be dropped.
    expect(constructed).toHaveLength(1);
    expect(constructed[0]).toMatchObject({
      extension: '.wav',
      isMeteringEnabled: true,
      outputFormat: 'lpcm',
      sampleRate: 16_000,
    });
    expect(constructed[0]).not.toHaveProperty('ios');
    // The session was put in record mode before the recorder was made.
    expect(audioModes).toEqual([true]);

    expect(await appleSpeech.stopRecording()).toBe('Lunch with Anna');
    expect(audioModes).toEqual([true, false]);
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
    expect(deleted).toEqual(['file:///recording.wav']);
    expect(audioModes).toEqual([true, false]);
  });

  it('a tap-to-stop recording transcribes whatever it holds', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    await appleSpeech.startRecording();
    await vi.advanceTimersByTimeAsync(500);

    expect(await appleSpeech.stopRecording()).toBe('Lunch with Anna');
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it('a recorder that does not start is reported, not left lit', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    starts = false;
    const events: Array<string> = [];
    await expect(
      appleSpeech.startRecording({ onSpeech: (event) => events.push(event) }),
    ).rejects.toThrow();
    metering = -20;
    await vi.advanceTimersByTimeAsync(3000);

    expect(events).toEqual([]);
    // Nothing became the recording, and nothing of it stayed behind.
    expect(await appleSpeech.stopRecording()).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
    expect(deleted).toEqual(['file:///recording.wav']);
    expect(audioModes).toEqual([true, false]);
  });

  it('a start given up while the recorder prepares records nothing', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    const controller = new AbortController();
    whilePreparing = () => controller.abort();
    const events: Array<string> = [];
    await appleSpeech.startRecording({
      onSpeech: (event) => events.push(event),
      signal: controller.signal,
    });
    metering = -20;
    await vi.advanceTimersByTimeAsync(3000);

    expect(events).toEqual([]);
    expect(await appleSpeech.stopRecording()).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
    expect(deleted).toEqual(['file:///recording.wav']);
    expect(audioModes).toEqual([true, false]);
  });
});
