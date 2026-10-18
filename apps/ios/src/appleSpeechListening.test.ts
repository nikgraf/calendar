import type { AudioRecorder, RecorderState } from 'expo-audio';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const URI = 'file:///recording.wav';
/** The level the fake recorder reports while it records, in dBFS; the test moves it. */
let metering = -60;
/** Whether `record()` starts a prepared recorder: off for the test of one that does not. */
let starts = true;
/** Runs inside `prepareToRecordAsync`: a test gives a start up from here. */
let whilePreparing: (() => void) | undefined;
/** `prepareToRecordAsync` waits for this first, when set: a start held mid-way. */
let prepareGate: Promise<void> | undefined;
/** `transcribe` waits for this first, when set: a phrase that takes a while to read. */
let transcribeGate: Promise<void> | undefined;
/** `setAudioModeAsync` waits for this first, when set: a start held at the mode call. */
let modeGate: Promise<void> | undefined;
/** The module's audio mode, as the last `setAudioModeAsync` left it. */
let allowsRecording = false;
const transcribe = vi.fn(async () => {
  await transcribeGate;
  return { segments: [{ text: 'Lunch with Anna' }] };
});
const deleted: Array<string> = [];
/** The recorders released, by their place in `recorders`. */
const released: Array<number> = [];
/** Every recorder constructed, in order — the native registry. */
const recorders: Array<FakeRecorder> = [];
/** Every `setAudioModeAsync` call's `allowsRecording`. */
const audioModes: Array<boolean> = [];

/**
 * expo-audio 57's recorder, as far as the adapter drives it: it records
 * only once prepared (unprepared, `record()` starts nothing), only while
 * the audio mode allows recording (`record()` throws otherwise, and a
 * mode taken out of record mode stops every recorder), its file is the
 * `uri` property, the meter of a recorder that is not running reads
 * digital silence, and nothing of it can be read once released.
 */
class FakeRecorder implements Pick<
  AudioRecorder,
  'getStatus' | 'isRecording' | 'prepareToRecordAsync' | 'record' | 'release' | 'stop' | 'uri'
> {
  allowsRecording = allowsRecording;
  /** The file this recorder writes: a media-services reset re-prepares it onto a new one. */
  file = URI;
  isRecording = false;
  readonly options: Record<string, unknown>;
  prepared = false;
  private released = false;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    recorders.push(this);
  }

  get uri() {
    this.alive();
    return this.file;
  }

  getStatus = (): RecorderState => {
    this.alive();
    return {
      canRecord: this.prepared,
      durationMillis: 0,
      isRecording: this.isRecording,
      mediaServicesDidReset: false,
      metering: this.isRecording ? metering : -160,
      url: this.file,
    };
  };

  prepareToRecordAsync = async () => {
    this.alive();
    await prepareGate;
    this.prepared = true;
    whilePreparing?.();
  };

  record = () => {
    this.alive();
    if (!this.allowsRecording) {
      throw new Error('Recording is disabled.');
    }
    if (this.prepared && starts) {
      this.isRecording = true;
    }
  };

  release = () => {
    this.isRecording = false;
    this.released = true;
    released.push(recorders.indexOf(this));
  };

  stop = async () => {
    this.alive();
    this.isRecording = false;
  };

  /** Nothing of a released shared object can be reached. */
  private alive() {
    if (this.released) {
      throw new Error('Unable to access a released shared object.');
    }
  }
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
    setAudioModeAsync: async (mode: { allowsRecording: boolean }) => {
      await modeGate;
      audioModes.push(mode.allowsRecording);
      allowsRecording = mode.allowsRecording;
      for (const recorder of recorders) {
        recorder.allowsRecording = mode.allowsRecording;
        if (!mode.allowsRecording) {
          recorder.isRecording = false;
        }
      }
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

/** A promise to open by hand. */
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, promise };
};

/** Lets every settled promise run its continuation. */
const settle = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
  // The adapter's state (the recording, the starts under way, the poll)
  // lives in its module: each test imports a fresh one, so a failure
  // cannot spill into the next. The fakes sit in Node's require cache,
  // which this does not touch.
  vi.resetModules();
  vi.useFakeTimers();
  metering = -60;
  starts = true;
  whilePreparing = undefined;
  prepareGate = undefined;
  transcribeGate = undefined;
  modeGate = undefined;
  allowsRecording = false;
  transcribe.mockClear();
  deleted.length = 0;
  released.length = 0;
  recorders.length = 0;
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
    // The audio deleted and the native recorder released.
    expect(deleted).toEqual([URI]);
    expect(released).toEqual([0]);
  });

  it('hands the recorder its options flat, in a session put in record mode first', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    await appleSpeech.startRecording();
    // The format keys at the top level, where the native constructor reads
    // them; under `ios` they would be dropped.
    expect(recorders).toHaveLength(1);
    expect(recorders[0]?.options).toMatchObject({
      extension: '.wav',
      isMeteringEnabled: true,
      outputFormat: 'lpcm',
      sampleRate: 16_000,
    });
    expect(recorders[0]?.options).not.toHaveProperty('ios');
    // Record mode before the recorder was made (it takes the mode then),
    // and `record()` after `prepareToRecordAsync()`: it is recording.
    expect(audioModes).toEqual([true]);
    expect(recorders[0]?.isRecording).toBe(true);

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
    expect(deleted).toEqual([URI]);
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
    expect(deleted).toEqual([URI]);
    expect(released).toEqual([0]);
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
    ).rejects.toThrow('did not start');
    metering = -20;
    await vi.advanceTimersByTimeAsync(3000);

    expect(events).toEqual([]);
    // Nothing became the recording, and nothing of it stayed behind.
    expect(await appleSpeech.stopRecording()).toBeUndefined();
    expect(transcribe).not.toHaveBeenCalled();
    expect(deleted).toEqual([URI]);
    expect(released).toEqual([0]);
    expect(audioModes).toEqual([true, false]);
  });

  it('a media-services reset mid-recording leaves no file behind', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    await appleSpeech.startRecording();
    // The system re-prepared the recorder onto a new file.
    const reset = 'file:///recording-after-reset.wav';
    recorders[0]!.file = reset;

    await appleSpeech.stopRecording();
    // The file it was started with and the one it ended with: both gone.
    expect(deleted).toEqual([URI, reset]);
    expect(released).toEqual([0]);
  });

  it('a recorder that refuses to record leaves nothing behind either', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    const { open, promise } = gate();
    prepareGate = promise;
    const start = appleSpeech.startRecording();
    await settle();
    // The mode left record mode while it prepared: `record()` throws.
    allowsRecording = false;
    for (const recorder of recorders) {
      recorder.allowsRecording = false;
    }
    open();
    await expect(start).rejects.toThrow('disabled');

    expect(deleted).toEqual([URI]);
    expect(released).toEqual([0]);
    expect(await appleSpeech.stopRecording()).toBeUndefined();
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
    // Released: expo-audio would start a prepared recorder it still knew
    // when the app next comes to the foreground.
    expect(deleted).toEqual([URI]);
    expect(released).toEqual([0]);
    expect(audioModes).toEqual([true, false]);
  });

  it('a stop still reading its phrase leaves the session to a start under way', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    // The first field's phrase is being read (a transcription takes a while)…
    await appleSpeech.startRecording();
    const reading = gate();
    transcribeGate = reading.promise;
    const stop = appleSpeech.stopRecording();
    await settle();
    expect(transcribe).toHaveBeenCalledTimes(1);
    // …when a second field starts, and is still preparing its recorder.
    const preparing = gate();
    prepareGate = preparing.promise;
    const start = appleSpeech.startRecording();
    await settle();
    expect(audioModes).toEqual([true, true]);
    // The first phrase lands: the session stays in record mode for the second.
    reading.open();
    expect(await stop).toBe('Lunch with Anna');
    expect(audioModes).toEqual([true, true]);
    preparing.open();
    await start;
    expect(recorders[1]?.isRecording).toBe(true);

    expect(await appleSpeech.stopRecording()).toBe('Lunch with Anna');
    expect(audioModes).toEqual([true, true, false]);
    expect(released).toEqual([0, 1]);
  });

  it('a stop landing while a start still asks for record mode leaves the session to it', async () => {
    const { appleSpeech } = await import('./appleSpeech.ts');
    // The first field's phrase is being read…
    await appleSpeech.startRecording();
    const reading = gate();
    transcribeGate = reading.promise;
    const stop = appleSpeech.stopRecording();
    await settle();
    // …when a second field starts and is held at its very first step, the
    // mode call: a start counts from before it, or a stop landing now
    // would queue "no recording" behind the second field's "recording".
    const mode = gate();
    modeGate = mode.promise;
    const start = appleSpeech.startRecording();
    await settle();
    reading.open();
    expect(await stop).toBe('Lunch with Anna');
    mode.open();
    await start;
    expect(audioModes).toEqual([true, true]);
    expect(recorders[1]?.isRecording).toBe(true);

    expect(await appleSpeech.stopRecording()).toBe('Lunch with Anna');
    expect(audioModes).toEqual([true, true, false]);
  });
});
