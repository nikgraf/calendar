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
/** What each microphone request asked of Chromium. */
const asked: Array<{ readonly audio: Readonly<Record<string, unknown>> }> = [];
/** Each worklet node created, for the test to post blocks through. */
const nodes: Array<{ port: { onmessage: ((message: { data: Float32Array }) => void) | null } }> =
  [];
let addModule: () => Promise<void> = async () => undefined;

const loadSpeech = async () => {
  vi.resetModules();
  const speech = (await import('./desktopSpeech.ts')).desktopSpeech;
  // Prepared, as the editor does before its first phrase: a start then goes
  // straight to the microphone. Without a bridge there is nothing to prepare.
  await speech.prepare().catch(() => undefined);
  return speech;
};

beforeEach(() => {
  vi.stubGlobal('document', { baseURI: 'file:///app/index.html' });
  vi.stubGlobal('navigator', {
    language: 'en-US',
    mediaDevices: {
      getUserMedia: (constraints: { readonly audio: Readonly<Record<string, unknown>> }) => {
        asked.push(constraints);
        return new Promise<FakeStream>((resolve) => grants.push(resolve));
      },
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
  asked.length = 0;
  grants.length = 0;
  nodes.length = 0;
  addModule = async () => undefined;
});

/** What main was asked, and the words listener the adapter subscribed. */
const bridge = () => {
  const audio: Array<{ readonly bytes: number; readonly session: number }> = [];
  const cancelled: Array<number> = [];
  const finished: Array<number> = [];
  const listeners = new Set<(words: { session: number; source: string; text: string }) => void>();
  const losers = new Set<(lost: { session: number }) => void>();
  let sessions = 0;
  let segments: ReadonlyArray<{ text: string }> = [{ text: 'Lunch with Anna' }];
  /** The phrase as the helper's other-language recogniser wrote it, when it has one. */
  let other: string | undefined;
  /** Set: the next prepares wait until the test lets them answer (a download). */
  let preparing: Promise<void> | undefined;
  /** What prepare and start were asked to listen in: "<locale> <second language>". */
  const prepared: Array<string> = [];
  const startedWith: Array<string> = [];
  /** Set: the next start waits until the test lets it answer. */
  let held: Promise<void> | undefined;
  vi.stubGlobal('window', {
    calendarBridge: {
      modelPrepareSpeech: async (locale: string, second: string) => {
        prepared.push(`${locale} ${second}`);
        await preparing;
        return { prepared: true };
      },
      modelSpeechAudio: (session: number, pcm: Uint8Array) => {
        audio.push({ bytes: pcm.byteLength, session });
      },
      modelSpeechCancel: async (session: number) => {
        cancelled.push(session);
      },
      modelSpeechFinish: async (session: number) => {
        finished.push(session);
        return other === undefined ? { segments } : { other, segments };
      },
      modelSpeechStart: async (locale: string, second: string) => {
        startedWith.push(`${locale} ${second}`);
        sessions += 1;
        const session = sessions;
        await held;
        return { session, sources: ['accurate', 'quick'] };
      },
      onSpeechLost: (listener: (lost: { session: number }) => void) => {
        losers.add(listener);
        return () => losers.delete(listener);
      },
      onSpeechWords: (
        listener: (words: { session: number; source: string; text: string }) => void,
      ) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
  });
  return {
    audio,
    cancelled,
    finished,
    hearNothing: () => {
      segments = [];
    },
    hearOther: (text: string) => {
      other = text;
    },
    holdPrepare: (until: Promise<void>) => {
      preparing = until;
    },
    prepared,
    startedWith,
    /** Main dropped this phrase: its helper went away. */
    lose: (session: number) => {
      for (const listener of losers) {
        listener({ session });
      }
    },
    /** How many sessions main was asked to start. */
    started: () => sessions,
    /** Holds the next start's answer; call the result to let it through. */
    holdStart: () => {
      let release: (() => void) | undefined;
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => release?.();
    },
    words: (session: number, source: string, text: string) => {
      for (const listener of listeners) {
        listener({ session, source, text });
      }
    },
  };
};

/** Lets the promises queued so far settle. */
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) {
    await Promise.resolve();
  }
};

const noWords = () => undefined;

describe('desktopSpeech microphone', () => {
  it('asks for Chromium’s voice processing unless Settings › Dictation turned it off', async () => {
    bridge();
    const stored = new Map<string, string>();
    Object.assign(window, { localStorage: { getItem: (key: string) => stored.get(key) ?? null } });
    const speech = await loadSpeech();
    // Nothing chosen on this Mac yet.
    void speech.start({ onWords: noWords });
    stored.set('dictation.reduceNoise', 'off');
    void speech.start({ onWords: noWords });
    await settle();
    expect(
      asked.map(({ audio }) => [
        audio.autoGainControl,
        audio.echoCancellation,
        audio.noiseSuppression,
      ]),
    ).toEqual([
      [true, true, true],
      [false, false, false],
    ]);
  });
});

describe('desktopSpeech languages', () => {
  it('listens in the Mac’s language and Automatic’s second until Settings › Dictation picks', async () => {
    const main = bridge();
    const stored = new Map<string, string>();
    Object.assign(window, { localStorage: { getItem: (key: string) => stored.get(key) ?? null } });
    Object.assign(navigator, { language: 'en-US' });
    const speech = await loadSpeech();
    const listen = async () => {
      const asked = grants.length;
      const start = speech.start({ onWords: noWords });
      // A language picked meanwhile is prepared before the microphone is asked for.
      await settle();
      expect(grants.length).toBe(asked + 1);
      grants.at(-1)?.(fakeStream());
      await start;
    };
    await listen();
    // Picked in Settings while the editor stayed open: the editor sees it
    // needs preparing, and a phrase prepares them first in any case.
    expect(speech.isPrepared?.()).toBe(true);
    stored.set('dictation.language', 'de-AT');
    stored.set('dictation.secondLanguage', 'off');
    expect(speech.isPrepared?.()).toBe(false);
    await listen();
    await listen();
    // An unreadable choice is automatic.
    stored.set('dictation.language', 'de; rm');
    stored.set('dictation.secondLanguage', 'en-GB');
    await listen();
    expect(main.prepared).toEqual(['en-US auto', 'de-AT off', 'en-US en-GB']);
    expect(main.startedWith).toEqual(['en-US auto', 'de-AT off', 'de-AT off', 'en-US en-GB']);
  });
});

describe('desktopSpeech preparing a newly picked language', () => {
  it('opens no microphone for a start given up while the language downloads', async () => {
    const main = bridge();
    const stored = new Map<string, string>();
    Object.assign(window, { localStorage: { getItem: (key: string) => stored.get(key) ?? null } });
    const speech = await loadSpeech();
    let downloaded: (() => void) | undefined;
    main.holdPrepare(
      new Promise<void>((resolve) => {
        downloaded = resolve;
      }),
    );
    stored.set('dictation.language', 'fr-FR');
    const closed = new AbortController();
    const start = speech.start({ onWords: noWords, signal: closed.signal });
    await settle();
    closed.abort();
    await speech.cancel();
    downloaded?.();
    await expect(start).resolves.toBeUndefined();
    expect(grants.length).toBe(0);
  });
});

describe('desktopSpeech listening ownership', () => {
  it('a start given up while the microphone is granted stops only its own stream', async () => {
    const main = bridge();
    const speech = await loadSpeech();
    // ⌘K closed while the first bar waited for the microphone, then reopened.
    const closed = new AbortController();
    const first = speech.start({ onWords: noWords, signal: closed.signal });
    closed.abort();
    const second = speech.start({ onWords: noWords });
    const current = fakeStream();
    const late = fakeStream();
    grants[1]?.(current);
    await second;
    grants[0]?.(late);
    await first;

    expect(late.stopped).toBe(true);
    expect(current.stopped).toBe(false);
    await speech.cancel();
    expect(current.stopped).toBe(true);
    expect(main.cancelled).toEqual([1]);
  });

  it('drops the session of a start given up once it had one', async () => {
    const main = bridge();
    const speech = await loadSpeech();
    const release = main.holdStart();
    const closed = new AbortController();
    const start = speech.start({ onWords: noWords, signal: closed.signal });
    const stream = fakeStream();
    grants[0]?.(stream);
    await settle();
    // Given up while main was starting the session: it has one by then.
    closed.abort();
    release();
    await start;
    expect(stream.stopped).toBe(true);
    await settle();
    expect(main.cancelled).toEqual([1]);
    expect(await speech.finish()).toBeUndefined();
  });

  it('a newer phrase stops the one it replaces', async () => {
    const main = bridge();
    const speech = await loadSpeech();
    const first = speech.start({ onWords: noWords });
    const older = fakeStream();
    grants[0]?.(older);
    await first;
    const second = speech.start({ onWords: noWords });
    const newer = fakeStream();
    grants[1]?.(newer);
    await second;

    expect(older.stopped).toBe(true);
    expect(newer.stopped).toBe(false);
    expect(main.cancelled).toEqual([1]);
    await speech.cancel();
    expect(newer.stopped).toBe(true);
  });

  it('starts no session for a start given up while the worklet loads', async () => {
    const main = bridge();
    const speech = await loadSpeech();
    let loaded: (() => void) | undefined;
    addModule = () =>
      new Promise<void>((resolve) => {
        loaded = resolve;
      });
    const closed = new AbortController();
    const start = speech.start({ onWords: noWords, signal: closed.signal });
    const stream = fakeStream();
    grants[0]?.(stream);
    await settle();
    // Given up while the worklet loaded: a session started now would drop
    // a newer caller's in the helper.
    closed.abort();
    loaded?.();
    await expect(start).resolves.toBeUndefined();
    expect(main.started()).toBe(0);
    expect(stream.stopped).toBe(true);
  });

  it('releases the microphone when the worklet fails to load', async () => {
    bridge();
    const speech = await loadSpeech();
    addModule = async () => {
      throw new Error('worklet blocked');
    };
    const start = speech.start({ onWords: noWords });
    const stream = fakeStream();
    grants[0]?.(stream);

    await expect(start).rejects.toThrow('worklet blocked');
    expect(stream.stopped).toBe(true);
  });
});

/** Posts `ms` of audio through the worklet, in its 128-sample blocks. */
const post = (ms: number) => {
  const node = nodes.at(-1);
  for (let sample = 0; sample < (16_000 * ms) / 1000; sample += 128) {
    node?.port.onmessage?.({ data: new Float32Array(128).fill(0.1) });
  }
};

describe('desktopSpeech streaming', () => {
  it('sends the microphone in 100 ms blocks of 16-bit samples, the rest when it finishes', async () => {
    const main = bridge();
    const speech = await loadSpeech();
    const start = speech.start({ onWords: noWords });
    grants[0]?.(fakeStream());
    await expect(start).resolves.toEqual({ sources: ['accurate', 'quick'] });
    post(250);
    // 1,664 samples a block (13 of the worklet's 128), 3,328 bytes.
    expect(main.audio).toEqual([
      { bytes: 3328, session: 1 },
      { bytes: 3328, session: 1 },
    ]);
    expect(await speech.finish()).toEqual({
      segments: [{ text: 'Lunch with Anna' }],
      text: 'Lunch with Anna',
    });
    // The worklet sent 32 blocks of 128: 768 samples were left over.
    expect(main.audio.at(-1)?.bytes).toBe((32 * 128 - 2 * 1664) * 2);
    expect(main.finished).toEqual([1]);
  });

  it('keeps the other language’s reading of the phrase beside it', async () => {
    const main = bridge();
    main.hearOther('Lunch mit Anna');
    const speech = await loadSpeech();
    const start = speech.start({ onWords: noWords });
    grants[0]?.(fakeStream());
    await start;
    expect(await speech.finish()).toEqual({
      other: 'Lunch mit Anna',
      segments: [{ text: 'Lunch with Anna' }],
      text: 'Lunch with Anna',
    });
  });

  it('passes on its own phrase’s words only', async () => {
    const main = bridge();
    const speech = await loadSpeech();
    const heard: Array<string> = [];
    const start = speech.start({ onWords: (source, text) => heard.push(`${source}: ${text}`) });
    grants[0]?.(fakeStream());
    await start;
    main.words(1, 'quick', 'Lunch');
    main.words(7, 'quick', 'someone else');
    main.words(1, 'accurate', 'Lunch with');
    await speech.finish();
    main.words(1, 'quick', 'Lunch with Anna');
    expect(heard).toEqual(['quick: Lunch', 'accurate: Lunch with']);
  });

  it('stops the microphone and says so when main loses the phrase', async () => {
    const main = bridge();
    const speech = await loadSpeech();
    let lost = 0;
    const stream = fakeStream();
    const start = speech.start({
      onLost: () => {
        lost += 1;
      },
      onWords: noWords,
    });
    grants[0]?.(stream);
    await start;
    main.lose(7);
    expect(lost).toBe(0);
    main.lose(1);
    expect(lost).toBe(1);
    expect(stream.stopped).toBe(true);
    // Nothing is left to finish.
    await expect(speech.finish()).resolves.toBeUndefined();
    expect(main.finished).toEqual([]);
  });

  it('reads nothing as nothing', async () => {
    const main = bridge();
    main.hearNothing();
    const speech = await loadSpeech();
    const start = speech.start({ onWords: noWords });
    const stream = fakeStream();
    grants[0]?.(stream);
    await start;
    expect(await speech.finish()).toBeUndefined();
    expect(stream.stopped).toBe(true);
  });
});

/** `isSupported` with main answering whether the helper responded. */
const supportedWith = async (status: { readonly helper: boolean }) => {
  vi.stubGlobal('window', { calendarBridge: { modelHelperStatus: async () => status } });
  return (await loadSpeech()).isSupported();
};

describe('desktopSpeech availability', () => {
  it('needs the helper and nothing else', async () => {
    // Apple Intelligence off or its model still downloading never reaches
    // here: main's reply is only whether the binary answered.
    expect(await supportedWith({ helper: true })).toBe(true);
    expect(await supportedWith({ helper: false })).toBe(false);
  });

  it('is unsupported when main cannot answer at all', async () => {
    vi.stubGlobal('window', {
      calendarBridge: {
        modelHelperStatus: async () => {
          throw new Error('no main');
        },
      },
    });
    expect(await (await loadSpeech()).isSupported()).toBe(false);
  });
});
