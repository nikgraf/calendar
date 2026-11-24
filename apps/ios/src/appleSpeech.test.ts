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
      | {
          other?: string;
          segments: ReadonlyArray<{ alternatives: ReadonlyArray<string>; text: string }>;
        }
      | null
      | undefined,
    installed: true,
    /** A binary that lists its languages, and so takes the second language. */
    listeners: new Set<(event: Words) => void>(),
    listsLanguages: true,
    microphone: true,
    prepareError: undefined as Error | undefined,
    /** Set: `read` rejects with it, as it does on an iPhone beside the live recognisers. */
    readError: undefined as Error | undefined,
    /** The phrases `finish` answers in turn; `finishes` once they ran out. */
    finishQueue: [] as Array<{
      other?: string;
      parakeet?: { raw: string; replacements: ReadonlyArray<never>; text: string };
      segments: ReadonlyArray<{ alternatives: ReadonlyArray<string>; text: string }>;
    }>,
    /** Sessions finished or cancelled: the module answers nothing for them again. */
    gone: new Set<number>(),
    /** Set: the next read waits until the test lets it through. */
    readHeld: undefined as Promise<void> | undefined,
    /** Set: the next finish waits until the test lets it through. */
    finishHeld: undefined as Promise<void> | undefined,
    /** Set: `finish` rejects with it. */
    finishError: undefined as Error | undefined,
    /** Set: the next start fails with it. */
    startError: undefined as Error | undefined,
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
        native.gone.add(session);
      },
      cut: (session: number, mark: number) => {
        native.calls.push(`cut ${session} ${mark}`);
      },
      finish: async (session: number) => {
        native.calls.push(`finish ${session}`);
        if (native.gone.has(session)) {
          return null;
        }
        native.gone.add(session);
        const held = native.finishHeld;
        native.finishHeld = undefined;
        await held;
        if (native.finishError) {
          throw native.finishError;
        }
        return native.finishQueue.shift() ?? native.finishes;
      },
      ...(native.listsLanguages
        ? { languages: async () => ({ automatic: 'de-AT', available: ['de-AT', 'en-US'] }) }
        : {}),
      prepare: async (locale: string, other?: string) => {
        native.calls.push(`prepare ${locale}${other === undefined ? '' : ` ${other}`}`);
        if (native.prepareError) {
          throw native.prepareError;
        }
      },
      read: async (session: number) => {
        native.calls.push(`read ${session}`);
        const held = native.readHeld;
        native.readHeld = undefined;
        await held;
        if (native.readError) {
          throw native.readError;
        }
        if (native.gone.has(session)) {
          return null;
        }
        return native.finishes ? { ...native.finishes, mark: 48_000 } : native.finishes;
      },
      requestMicrophone: async () => native.microphone,
      start: async (session: number, locale: string, voiceProcessing: boolean, other?: string) => {
        native.calls.push(
          `start ${session} ${voiceProcessing ? 'processed' : 'plain'}${locale === 'en-US' ? '' : ` ${locale}`}${other === 'auto' ? '' : ` second ${other ?? 'none'}`}`,
        );
        await native.held;
        const failure = native.startError;
        native.startError = undefined;
        if (failure) {
          throw failure;
        }
        return { sources: ['accurate'] };
      },
    };
  },
}));

/** This iPhone's notes, by file: none until a setting is switched. */
const notes = vi.hoisted(() => new Map<string, string>());
const VOICE = 'voice-processing.json';
const LANGUAGES = 'dictation-languages.json';
const DICTATION_ERROR = 'last-dictation-error.txt';

vi.mock('expo-file-system', () => ({
  File: class {
    constructor(
      _directory: string,
      private readonly name: string,
    ) {}
    get exists() {
      return notes.has(this.name);
    }
    textSync() {
      return notes.get(this.name) ?? '';
    }
    writeSync(text: string) {
      notes.set(this.name, text);
    }
  },
  Paths: { document: '/documents' },
}));

/** A phrase as the module reads it whole. */
const phrase = (text: string) => ({ segments: [{ alternatives: [], text }] });

/** Holds the next finish until the returned function lets it through. */
const holdFinish = () => {
  let release: (() => void) | undefined;
  native.finishHeld = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => release?.();
};

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

/**
 * The calls apart from the prepare a first start makes itself: these tests
 * start without the editor's own prepare.
 */
const startCalls = () => native.calls.filter((call) => !call.startsWith('prepare '));

// Each test loads the adapter afresh, and @calendar/ai with it: errors are
// told by their tag.
const unsupported = { _tag: 'SpeechUnsupportedError' };
const denied = { _tag: 'MicrophoneDeniedError' };

beforeEach(() => {
  native.calls.length = 0;
  native.listsLanguages = true;
  // The iPhone's language, whatever the machine's: calls name another locale only.
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...new Intl.DateTimeFormat('en-US').resolvedOptions(),
    locale: 'en-US',
  });
  native.finishes = { segments: [{ alternatives: ['Lunch with Sara'], text: 'Lunch with Sarah' }] };
  native.held = undefined;
  native.installed = true;
  native.listeners.clear();
  native.microphone = true;
  native.prepareError = undefined;
  native.readError = undefined;
  native.finishQueue.length = 0;
  native.finishError = undefined;
  native.finishHeld = undefined;
  native.readHeld = undefined;
  native.gone.clear();
  native.startError = undefined;
  notes.clear();
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
    expect(startCalls()).toEqual(['start 1 processed']);
    say({ session: 1, source: 'quick', text: 'Lunch' });
    say({ session: 9, source: 'quick', text: 'someone else' });
    say({ session: 1, source: 'accurate', text: 'Lunch with' });

    await expect(speech.finish()).resolves.toEqual({
      segments: [{ alternatives: ['Lunch with Sara'], text: 'Lunch with Sarah' }],
      text: 'Lunch with Sarah',
    });
    say({ session: 1, source: 'quick', text: 'Lunch with Sarah' });
    expect(heard).toEqual(['quick: Lunch', 'accurate: Lunch with']);
    expect(startCalls()).toEqual(['start 1 processed', 'finish 1']);
    expect(native.listeners.size).toBe(0);
  });

  it('keeps the other language’s reading of the phrase beside it', async () => {
    native.finishes = {
      other: 'Mit Tom at the Naschmarkt',
      segments: [{ alternatives: [], text: 'Meet Tom at the Nashmacht' }],
    };
    const speech = await loadSpeech();
    await speech.start({ onWords: noWords });
    await expect(speech.finish()).resolves.toEqual({
      other: 'Mit Tom at the Naschmarkt',
      segments: [{ alternatives: [], text: 'Meet Tom at the Nashmacht' }],
      text: 'Meet Tom at the Nashmacht',
    });
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
    // Prepared, as the editor does first: the start goes straight to the module.
    await speech.prepare();
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
    expect(startCalls()).toEqual(['start 1 processed', 'cancel 1']);
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
    expect(startCalls()).toEqual(['start 1 processed', 'start 2 processed', 'cancel 2']);
  });

  it('records through voice processing unless this iPhone switched it off', async () => {
    notes.set(VOICE, JSON.stringify({ on: false }));
    const plain = await loadSpeech();
    await plain.start({ onWords: noWords });
    notes.set(VOICE, 'not json');
    const unreadable = await loadSpeech();
    await unreadable.start({ onWords: noWords });
    notes.set(VOICE, JSON.stringify({ on: true }));
    const processed = await loadSpeech();
    await processed.start({ onWords: noWords });
    expect(startCalls()).toEqual(['start 1 plain', 'start 1 processed', 'start 1 processed']);
  });

  it('listens in the language and second language Settings › Dictation picked', async () => {
    notes.set(LANGUAGES, JSON.stringify({ language: 'de-AT', second: 'off' }));
    const picked = await loadSpeech();
    await picked.prepare();
    await picked.start({ onWords: noWords });
    notes.set(LANGUAGES, '{"language": "not a language"}');
    const unreadable = await loadSpeech();
    await unreadable.prepare();
    await unreadable.start({ onWords: noWords });
    expect(native.calls).toEqual([
      'prepare de-AT off',
      'start 1 processed de-AT second off',
      'prepare en-US auto',
      'start 1 processed',
    ]);
  });

  it('prepares languages picked while an editor stayed open before their first phrase', async () => {
    const speech = await loadSpeech();
    await speech.prepare();
    await speech.start({ onWords: noWords });
    // Settings › Dictation, the editor still open: no prepare from it.
    expect(speech.isPrepared?.()).toBe(true);
    (await import('./dictationLanguages.ts')).secondLanguage.set('fr-FR');
    // The editor asks, and shows it preparing.
    expect(speech.isPrepared?.()).toBe(false);
    await speech.start({ onWords: noWords });
    await speech.start({ onWords: noWords });
    expect(native.calls).toEqual([
      'prepare en-US auto',
      'start 1 processed',
      'prepare en-US fr-FR',
      'start 2 processed second fr-FR',
      'start 3 processed second fr-FR',
    ]);
  });

  it('asks a binary that cannot list languages as before: no second language', async () => {
    native.listsLanguages = false;
    notes.set(LANGUAGES, JSON.stringify({ language: 'de-AT', second: 'fr-FR' }));
    const speech = await loadSpeech();
    await speech.prepare();
    await speech.start({ onWords: noWords });
    expect(native.calls).toEqual(['prepare en-US', 'start 1 processed second none']);
  });

  it('tells a locale that never will from a download that failed', async () => {
    const speech = await loadSpeech();
    native.prepareError = new Error('unsupported: locale not supported: xx-XX');
    await expect(speech.prepare()).rejects.toMatchObject(unsupported);
    native.prepareError = new Error('failed: The network connection was lost.');
    await expect(speech.prepare()).rejects.toThrow('network connection');
  });

  it('reads the phrase so far with the microphone left open', async () => {
    const speech = await loadSpeech();
    await speech.start({ onWords: noWords });
    await expect(speech.read()).resolves.toEqual({
      heard: {
        segments: [{ alternatives: ['Lunch with Sara'], text: 'Lunch with Sarah' }],
        text: 'Lunch with Sarah',
      },
      mark: 48_000,
    });
    speech.cut(48_000);
    expect(startCalls()).toEqual(['start 1 processed', 'read 1', 'cut 1 48000']);
    expect(notes.has(DICTATION_ERROR)).toBe(false);
  });

  describe('when the reading beside the live recognisers fails', () => {
    beforeEach(() => {
      native.readError = new Error('SpeechError: failed: The operation couldn’t be completed.');
    });

    it('reads it as a finished phrase, opens the microphone again and keeps the error', async () => {
      const speech = await loadSpeech();
      const heard: Array<string> = [];
      await speech.start({ onWords: (source, text) => heard.push(`${source}: ${text}`) });
      say({ session: 1, source: 'accurate', text: 'Lunch with Sarah' });
      native.finishQueue.push(phrase('Lunch with Sarah'));

      await expect(speech.read()).resolves.toEqual({
        heard: { segments: phrase('Lunch with Sarah').segments, text: 'Lunch with Sarah' },
        mark: 0,
      });
      expect(startCalls()).toEqual([
        'start 1 processed',
        'read 1',
        'finish 1',
        'start 2 processed',
      ]);
      expect(notes.get(DICTATION_ERROR)).toMatch(/\nread: Error: SpeechError: failed/);

      // The words go on from the listening's, the old session's are gone.
      say({ session: 1, source: 'accurate', text: 'stale' });
      say({ session: 2, source: 'accurate', text: 'tomorrow' });
      expect(heard).toEqual(['accurate: Lunch with Sarah', 'accurate: Lunch with Sarah tomorrow']);
      expect(native.listeners.size).toBe(1);

      // The next phrase is read and finished in the new session.
      speech.cut(0);
      native.finishQueue.push(phrase('Tomorrow at one'));
      await expect(speech.finish()).resolves.toMatchObject({ text: 'Tomorrow at one' });
      expect(startCalls().slice(-2)).toEqual(['cut 2 0', 'finish 2']);
    });

    it('reads a phrase that grew before it landed whole', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishQueue.push(phrase('Lunch with Sarah'), phrase('tomorrow at one'));
      await speech.read();
      // Not cut: words followed before it landed, and it is read again.
      await expect(speech.read()).resolves.toMatchObject({
        heard: { text: 'Lunch with Sarah tomorrow at one' },
        mark: 0,
      });
      speech.cut(0);
      native.finishQueue.push(phrase('Dinner instead'));
      await expect(speech.read()).resolves.toMatchObject({ heard: { text: 'Dinner instead' } });
    });

    it('opens nothing again for a listening given up while it was read', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      let release: (() => void) | undefined;
      native.held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = speech.read();
      // The new session is on its way when the editor closes.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await speech.cancel();
      release?.();
      await read;
      expect(startCalls()).toEqual([
        'start 1 processed',
        'read 1',
        'finish 1',
        'start 2 processed',
        // The finished session's cancel finds nothing; the opened one's closes it.
        'cancel 1',
        'cancel 2',
      ]);
      expect(native.listeners.size).toBe(0);
    });

    it('tells the listener its listening is lost when the microphone cannot open again', async () => {
      const speech = await loadSpeech();
      const lost = vi.fn();
      await speech.start({ onLost: lost, onWords: noWords });
      native.startError = new Error('SpeechError: no microphone');
      await expect(speech.read()).resolves.toMatchObject({ mark: 0 });
      // Told once the phrase reached the editor, so its message is the last word.
      expect(lost).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(lost).toHaveBeenCalledOnce();
      expect(notes.get(DICTATION_ERROR)).toMatch(/\nstart: Error: SpeechError: no microphone/);
      await expect(speech.read()).resolves.toBeUndefined();
    });

    it('fails as before when the finished reading fails too', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishError = new Error('SpeechError: failed: busy');
      await expect(speech.read()).rejects.toThrow('busy');
      expect(notes.get(DICTATION_ERROR)).toMatch(/\nfinish: Error: SpeechError: failed: busy/);
    });

    it('still delivers the phrase on its way when dictation ends while it is read', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishQueue.push(phrase('Lunch with Sarah'));
      const release = holdFinish();
      const read = speech.read();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // "That's all" with nothing said since: the editor cancels, the phrase still lands.
      await speech.cancel();
      release();
      await expect(read).resolves.toMatchObject({ heard: { text: 'Lunch with Sarah' }, mark: 0 });
      expect(startCalls()).toEqual(['start 1 processed', 'read 1', 'finish 1', 'cancel 1']);
    });

    it('gives a finish meanwhile the phrase being read', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishQueue.push(phrase('Lunch with Sarah'));
      const release = holdFinish();
      const read = speech.read();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // A hold lifted: the editor reads everything since the last phrase landed.
      const finished = speech.finish();
      release();
      await expect(finished).resolves.toMatchObject({ text: 'Lunch with Sarah' });
      await read;
      expect(startCalls()).toEqual(['start 1 processed', 'read 1', 'finish 1']);
      expect(native.listeners.size).toBe(0);
    });

    it('gives a second read meanwhile the same phrase, without finishing again', async () => {
      const speech = await loadSpeech();
      const lost = vi.fn();
      await speech.start({ onLost: lost, onWords: noWords });
      native.finishQueue.push(phrase('Lunch with Sarah'));
      const release = holdFinish();
      const first = speech.read();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = speech.read();
      release();
      await expect(first).resolves.toMatchObject({ heard: { text: 'Lunch with Sarah' } });
      await expect(second).resolves.toMatchObject({ heard: { text: 'Lunch with Sarah' } });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(lost).not.toHaveBeenCalled();
      expect(startCalls()).toEqual([
        'start 1 processed',
        'read 1',
        'finish 1',
        'start 2 processed',
      ]);
    });

    it('keeps Parakeet’s reading of the phrase when nothing follows it', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishQueue.push({
        ...phrase('Lunch with Sara'),
        parakeet: { raw: 'Lunch with Sarah', replacements: [], text: 'Lunch with Sarah' },
      });
      await speech.read();
      native.finishQueue.push({ segments: [] });
      await expect(speech.finish()).resolves.toMatchObject({
        apple: 'Lunch with Sara',
        text: 'Lunch with Sarah',
      });
    });

    it('still delivers the phrase when dictation ends before the module’s read failed', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishQueue.push(phrase('Lunch with Sarah'));
      let release: (() => void) | undefined;
      native.readHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = speech.read();
      await new Promise((resolve) => setTimeout(resolve, 0));
      // "That's all" while the module still reads: the session is finished, not dropped.
      await speech.cancel();
      release?.();
      await expect(read).resolves.toMatchObject({ heard: { text: 'Lunch with Sarah' }, mark: 0 });
      expect(startCalls()).toEqual(['start 1 processed', 'read 1', 'finish 1']);
      expect(native.listeners.size).toBe(0);
    });

    it('lets a noise pause read that way go before the next phrase', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishQueue.push({ segments: [] });
      await expect(speech.read()).resolves.toEqual({ heard: undefined, mark: 0 });
      // Never cut (a hold began meanwhile): the held phrase keeps Parakeet's reading.
      native.finishQueue.push({
        ...phrase('Lunch with Sara'),
        parakeet: { raw: 'Lunch with Sarah', replacements: [], text: 'Lunch with Sarah' },
      });
      await expect(speech.finish()).resolves.toMatchObject({
        apple: 'Lunch with Sara',
        text: 'Lunch with Sarah',
      });
    });

    it('opens nothing again over a newer start begun while the phrase was read', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishQueue.push(phrase('Lunch with Sarah'));
      const release = holdFinish();
      const read = speech.read();
      await new Promise((resolve) => setTimeout(resolve, 0));
      const newer = speech.start({ onWords: noWords });
      release();
      await read;
      await expect(newer).resolves.toEqual({ sources: ['accurate'] });
      expect(startCalls()).toEqual([
        'start 1 processed',
        'read 1',
        'finish 1',
        'start 2 processed',
      ]);
      native.finishQueue.push(phrase('Dinner'));
      await expect(speech.finish()).resolves.toMatchObject({ text: 'Dinner' });
    });

    it('cancels a reopened listening in the module, with no reading left over', async () => {
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      native.finishQueue.push(phrase('Lunch with Sarah'));
      await speech.read();
      speech.cut(0);
      await speech.cancel();
      expect(startCalls()).toEqual([
        'start 1 processed',
        'read 1',
        'finish 1',
        'start 2 processed',
        'cut 2 0',
        'cancel 2',
      ]);
    });

    it('counts the lagging recogniser’s first word after reopening as a new one', async () => {
      const speech = await loadSpeech();
      const heard: Array<string> = [];
      await speech.start({ onWords: (source, text) => heard.push(`${source}: ${text}`) });
      say({ session: 1, source: 'accurate', text: 'Lunch' });
      say({ session: 1, source: 'quick', text: 'Lunch with Sarah' });
      native.finishQueue.push(phrase('Lunch with Sarah'));
      await speech.read();
      say({ session: 2, source: 'accurate', text: 'Tomorrow' });
      expect(heard).toEqual([
        'accurate: Lunch',
        'quick: Lunch with Sarah',
        'accurate: Lunch with Sarah',
        'accurate: Lunch with Sarah Tomorrow',
      ]);
    });

    it('never raises the quick recogniser when it heard less than the accurate one', async () => {
      const speech = await loadSpeech();
      const heard: Array<string> = [];
      await speech.start({ onWords: (source, text) => heard.push(`${source}: ${text}`) });
      say({ session: 1, source: 'accurate', text: 'Lunch at 3 PM' });
      say({ session: 1, source: 'quick', text: 'Lunch at 3PM' });
      native.finishQueue.push(phrase('Lunch at 3 PM'));
      await speech.read();
      say({ session: 2, source: 'quick', text: 'Tomorrow' });
      expect(heard).toEqual([
        'accurate: Lunch at 3 PM',
        'quick: Lunch at 3PM',
        'quick: Lunch at 3PM Tomorrow',
      ]);
    });

    it('gives the phrase to a read the module answered with nothing once ended as a finish', async () => {
      native.readError = undefined;
      const speech = await loadSpeech();
      await speech.start({ onWords: noWords });
      let release: (() => void) | undefined;
      native.readHeld = new Promise<void>((resolve) => {
        release = resolve;
      });
      native.finishQueue.push(phrase('Lunch with Sarah'));
      const read = speech.read();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await speech.cancel();
      // The module answers the read with nothing: its finish took the session.
      release?.();
      await expect(read).resolves.toMatchObject({ heard: { text: 'Lunch with Sarah' }, mark: 0 });
    });
  });
});
