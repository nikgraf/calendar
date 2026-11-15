import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

interface Words {
  readonly session: number;
  readonly source: 'accurate' | 'quick';
  readonly text: string;
}

/**
 * The native module as `modules/solunivo-speech` declares it: what the
 * adapter asked, and the words it can send. Absent: a binary built
 * without the module.
 */
const native = vi.hoisted(() => {
  const state = {
    calls: [] as Array<string>,
    finishes: undefined as
      | { segments: ReadonlyArray<{ alternatives: ReadonlyArray<string>; text: string }> }
      | null
      | undefined,
    installed: true,
    listeners: new Set<(event: Words) => void>(),
    microphone: true,
    prepareError: undefined as Error | undefined,
    /** Set: the next start waits until the test lets it through. */
    held: undefined as Promise<void> | undefined,
  };
  return state;
});

vi.mock('expo', () => ({
  requireNativeModule: (name: string) => {
    if (!native.installed) {
      throw new Error(`Cannot find native module '${name}'`);
    }
    return {
      addListener: (_name: 'onWords', listener: (event: Words) => void) => {
        native.listeners.add(listener);
        return { remove: () => native.listeners.delete(listener) };
      },
      cancel: async (session: number) => {
        native.calls.push(`cancel ${session}`);
      },
      finish: async (session: number) => {
        native.calls.push(`finish ${session}`);
        return native.finishes;
      },
      prepare: async (locale: string) => {
        native.calls.push(`prepare ${locale}`);
        if (native.prepareError) {
          throw native.prepareError;
        }
      },
      requestMicrophone: async () => native.microphone,
      start: async (session: number, _locale: string, voiceProcessing: boolean) => {
        native.calls.push(`start ${session} ${voiceProcessing ? 'processed' : 'plain'}`);
        await native.held;
        return { sources: ['accurate'] };
      },
    };
  },
}));

/** Reduce Background Noise's note on this iPhone: none until it is switched. */
const note = vi.hoisted(() => ({ text: undefined as string | undefined }));

vi.mock('expo-file-system', () => ({
  File: class {
    get exists() {
      return note.text !== undefined;
    }
    textSync() {
      return note.text ?? '';
    }
  },
  Paths: { document: '/documents' },
}));

const say = (event: Words) => {
  for (const listener of native.listeners) {
    listener(event);
  }
};

const loadSpeech = async () => {
  vi.resetModules();
  return (await import('./appleSpeech.ts')).appleSpeech;
};

const noWords = () => undefined;

// Each test loads the adapter afresh, and @calendar/ai with it: errors are
// told by their tag.
const unsupported = { _tag: 'SpeechUnsupportedError' };
const denied = { _tag: 'MicrophoneDeniedError' };

beforeEach(() => {
  native.calls.length = 0;
  native.finishes = { segments: [{ alternatives: ['Lunch with Sara'], text: 'Lunch with Sarah' }] };
  native.held = undefined;
  native.installed = true;
  native.listeners.clear();
  native.microphone = true;
  native.prepareError = undefined;
  note.text = undefined;
});

describe('appleSpeech without the native module', () => {
  beforeEach(() => {
    native.installed = false;
  });

  it('imports cleanly and reports itself unsupported', async () => {
    const speech = await loadSpeech();
    await expect(speech.isSupported()).resolves.toBe(false);
    await expect(speech.prepare()).rejects.toMatchObject(unsupported);
    await expect(speech.start({ onWords: noWords })).rejects.toMatchObject(unsupported);
  });

  it('finishing or cancelling without a phrase is harmless', async () => {
    const speech = await loadSpeech();
    await expect(speech.finish()).resolves.toBeUndefined();
    await expect(speech.cancel()).resolves.toBeUndefined();
  });
});

describe('appleSpeech', () => {
  it('passes on its own phrase’s words, and reads the phrase whole at the end', async () => {
    const speech = await loadSpeech();
    const heard: Array<string> = [];
    // Only the accurate recogniser listens: the quick one's assets are missing.
    await expect(
      speech.start({ onWords: (source, text) => heard.push(`${source}: ${text}`) }),
    ).resolves.toEqual({ sources: ['accurate'] });
    expect(native.calls).toEqual(['start 1 processed']);
    say({ session: 1, source: 'quick', text: 'Lunch' });
    say({ session: 9, source: 'quick', text: 'someone else' });
    say({ session: 1, source: 'accurate', text: 'Lunch with' });

    await expect(speech.finish()).resolves.toEqual({
      segments: [{ alternatives: ['Lunch with Sara'], text: 'Lunch with Sarah' }],
      text: 'Lunch with Sarah',
    });
    say({ session: 1, source: 'quick', text: 'Lunch with Sarah' });
    expect(heard).toEqual(['quick: Lunch', 'accurate: Lunch with']);
    expect(native.calls).toEqual(['start 1 processed', 'finish 1']);
    expect(native.listeners.size).toBe(0);
  });

  it('reads a phrase the module no longer holds as nothing', async () => {
    native.finishes = null;
    const speech = await loadSpeech();
    await speech.start({ onWords: noWords });
    await expect(speech.finish()).resolves.toBeUndefined();
  });

  it('opens nothing when the microphone is declined', async () => {
    native.microphone = false;
    const speech = await loadSpeech();
    await expect(speech.start({ onWords: noWords })).rejects.toMatchObject(denied);
    expect(native.calls).toEqual([]);
  });

  it('drops only its own phrase when given up while the microphone opens', async () => {
    const speech = await loadSpeech();
    let release: (() => void) | undefined;
    native.held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const closed = new AbortController();
    const start = speech.start({ onWords: noWords, signal: closed.signal });
    await Promise.resolve();
    closed.abort();
    release?.();
    await expect(start).resolves.toBeUndefined();
    expect(native.calls).toEqual(['start 1 processed', 'cancel 1']);
    expect(native.listeners.size).toBe(0);
    // Not the current phrase: nothing to finish.
    await expect(speech.finish()).resolves.toBeUndefined();
    expect(native.calls).not.toContain('finish 1');
  });

  it('a newer phrase takes over the words', async () => {
    const speech = await loadSpeech();
    await speech.start({ onWords: noWords });
    const heard: Array<string> = [];
    await speech.start({ onWords: (_source, text) => heard.push(text) });
    expect(native.listeners.size).toBe(1);
    say({ session: 2, source: 'quick', text: 'Dinner' });
    expect(heard).toEqual(['Dinner']);
    await speech.cancel();
    expect(native.calls).toEqual(['start 1 processed', 'start 2 processed', 'cancel 2']);
  });

  it('records through voice processing unless this iPhone switched it off', async () => {
    note.text = JSON.stringify({ on: false });
    const plain = await loadSpeech();
    await plain.start({ onWords: noWords });
    note.text = 'not json';
    const unreadable = await loadSpeech();
    await unreadable.start({ onWords: noWords });
    note.text = JSON.stringify({ on: true });
    const processed = await loadSpeech();
    await processed.start({ onWords: noWords });
    expect(native.calls).toEqual(['start 1 plain', 'start 1 processed', 'start 1 processed']);
  });

  it('tells a locale that never will from a download that failed', async () => {
    const speech = await loadSpeech();
    native.prepareError = new Error('unsupported: locale not supported: xx-XX');
    await expect(speech.prepare()).rejects.toMatchObject(unsupported);
    native.prepareError = new Error('failed: The network connection was lost.');
    await expect(speech.prepare()).rejects.toThrow('network connection');
  });
});
