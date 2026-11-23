import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type Handler = (event: { sender: Sender }, ...args: Array<unknown>) => unknown;
interface Sender {
  readonly destroy: () => void;
  readonly isDestroyed: () => boolean;
  readonly lost: Array<unknown>;
  readonly once: (name: 'destroyed', listener: () => void) => void;
  readonly send: (channel: string, payload: unknown) => void;
  readonly sent: Array<unknown>;
}

const main = vi.hoisted(() => ({
  calls: [] as Array<{ method: string; params: unknown }>,
  exits: [] as Array<() => void>,
  handlers: new Map<string, Handler>(),
  helperEvents: new Map<string, (body: Record<string, unknown>) => void>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: Handler) => main.handlers.set(channel, handler),
    on: (channel: string, handler: Handler) => main.handlers.set(channel, handler),
  },
  systemPreferences: { askForMediaAccess: async () => true },
}));

vi.mock('./helperProcess.ts', () => ({
  callHelper: async (method: string, params: unknown) => {
    main.calls.push({ method, params });
    if (method === 'speech.read') {
      return { mark: 32_000, segments: [{ alternatives: [], text: 'Lunch' }] };
    }
    if (method === 'speech.finish') {
      return { segments: [{ alternatives: [], text: 'Lunch' }] };
    }
    return method === 'speech.start' ? { sources: ['accurate', 'quick'] } : {};
  },
  onHelperEvent: (name: string, listener: (body: Record<string, unknown>) => void) => {
    main.helperEvents.set(name, listener);
    return () => undefined;
  },
  onHelperExit: (listener: () => void) => {
    main.exits.push(listener);
    return () => undefined;
  },
  registerHelperLifecycle: () => undefined,
}));

vi.mock('./modelProvider.ts', () => ({
  getModelProvider: () => undefined,
  providerGenerate: async () => ({}),
  providerInfo: () => ({}),
  providerStatus: async () => ({}),
  servedModelActive: () => false,
  setModelProvider: async () => ({}),
  testModelProvider: async () => ({}),
}));

const sender = (): Sender => {
  const sent: Array<unknown> = [];
  const lost: Array<unknown> = [];
  const closing: Array<() => void> = [];
  let destroyed = false;
  return {
    destroy: () => {
      destroyed = true;
      for (const listener of closing.splice(0)) {
        listener();
      }
    },
    isDestroyed: () => destroyed,
    lost,
    once: (_name, listener) => {
      closing.push(listener);
    },
    send: (channel, payload) => (channel === 'model:speech-lost' ? lost : sent).push(payload),
    sent,
  };
};

const call = (channel: string, from: Sender, ...args: Array<unknown>) => {
  const handler = main.handlers.get(channel);
  if (!handler) {
    throw new Error(`no handler for ${channel}`);
  }
  return handler({ sender: from }, ...args);
};

const helperSays = (body: Record<string, unknown>) => main.helperEvents.get('speech.words')?.(body);

beforeEach(async () => {
  main.calls.length = 0;
  main.exits.length = 0;
  main.handlers.clear();
  main.helperEvents.clear();
  vi.resetModules();
  const { registerModelHelper } = await import('./modelHelper.ts');
  registerModelHelper();
});

describe('dictation in main', () => {
  it('starts a phrase on the helper and gives the window its session', async () => {
    const window = sender();
    await expect(call('model:speech-start', window, 'en-US')).resolves.toEqual({
      session: 1,
      sources: ['accurate', 'quick'],
    });
    expect(main.calls).toEqual([
      { method: 'speech.start', params: { locale: 'en-US', session: 1 } },
    ]);
    await expect(call('model:speech-start', window, 'not a locale!')).rejects.toThrow(
      'invalid locale',
    );
  });

  it('passes the window’s audio on, as base64, and nobody else’s', async () => {
    const window = sender();
    const other = sender();
    await call('model:speech-start', window, 'en-US');
    main.calls.length = 0;
    call('model:speech-audio', window, 1, new Uint8Array([1, 0, 255, 127]));
    call('model:speech-audio', other, 1, new Uint8Array([1, 0]));
    call('model:speech-audio', window, 2, new Uint8Array([1, 0]));
    call('model:speech-audio', window, 1, 'not audio');
    call('model:speech-audio', window, 1, new Uint8Array(64_000));
    expect(main.calls).toEqual([
      { method: 'speech.audio', params: { pcmBase64: 'AQD/fw==', session: 1 } },
    ]);
  });

  it('pushes the phrase’s words to the window listening, until it is finished', async () => {
    const window = sender();
    await call('model:speech-start', window, 'en-US');
    helperSays({ session: 1, source: 'quick', text: 'Lunch' });
    helperSays({ session: 9, source: 'quick', text: 'an older phrase' });
    helperSays({ session: 1, source: 'nobody', text: 'not a recogniser' });
    await expect(call('model:speech-finish', window, 1)).resolves.toEqual({
      segments: [{ alternatives: [], text: 'Lunch' }],
    });
    helperSays({ session: 1, source: 'accurate', text: 'Lunch with' });
    call('model:speech-audio', window, 1, new Uint8Array([1, 0]));
    expect(window.sent).toEqual([{ session: 1, source: 'quick', text: 'Lunch' }]);
    expect(main.calls.map((entry) => entry.method)).toEqual(['speech.start', 'speech.finish']);
  });

  it('a newer phrase takes the words over; a cancel drops only its own', async () => {
    const first = sender();
    const second = sender();
    await call('model:speech-start', first, 'en-US');
    await call('model:speech-start', second, 'en-US');
    await call('model:speech-cancel', first, 1);
    helperSays({ session: 2, source: 'quick', text: 'Dinner' });
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([{ session: 2, source: 'quick', text: 'Dinner' }]);
    expect(main.calls.at(-1)).toEqual({ method: 'speech.cancel', params: { session: 1 } });
  });

  it('drops the phrase of a window closed mid-phrase', async () => {
    const window = sender();
    await call('model:speech-start', window, 'en-US');
    window.destroy();
    expect(main.calls.at(-1)).toEqual({ method: 'speech.cancel', params: { session: 1 } });
    helperSays({ session: 1, source: 'quick', text: 'Lunch' });
    expect(window.sent).toEqual([]);
  });

  it('lets only the window listening end its phrase', async () => {
    const window = sender();
    const other = sender();
    await call('model:speech-start', window, 'en-US');
    await expect(call('model:speech-finish', other, 1)).rejects.toThrow('invalid session');
    await expect(call('model:speech-cancel', other, 1)).rejects.toThrow('invalid session');
    helperSays({ session: 1, source: 'quick', text: 'Lunch' });
    expect(window.sent).toEqual([{ session: 1, source: 'quick', text: 'Lunch' }]);
    expect(main.calls.map((entry) => entry.method)).toEqual(['speech.start']);
  });

  it('reads the window’s phrase listening on, and lets go of it once it landed', async () => {
    const window = sender();
    const other = sender();
    await call('model:speech-start', window, 'en-US');
    await expect(call('model:speech-read', window, 1)).resolves.toEqual({
      mark: 32_000,
      segments: [{ alternatives: [], text: 'Lunch' }],
    });
    // Another window's, an older phrase's, a mark that is no frame: nothing.
    expect(await call('model:speech-read', other, 1)).toEqual({ segments: [] });
    expect(await call('model:speech-read', window, 2)).toEqual({ segments: [] });
    call('model:speech-cut', other, 1, 32_000);
    call('model:speech-cut', window, 1, -1);
    call('model:speech-cut', window, 1, 1.5);
    call('model:speech-cut', window, 1, 32_000);
    // Still listening: the words keep coming to the window.
    helperSays({ session: 1, source: 'quick', text: 'Lunch make it two' });
    expect(window.sent).toEqual([{ session: 1, source: 'quick', text: 'Lunch make it two' }]);
    expect(main.calls.slice(1)).toEqual([
      { method: 'speech.read', params: { session: 1 } },
      { method: 'speech.cut', params: { mark: 32_000, session: 1 } },
    ]);
  });

  it('tells the window its phrase was lost when the helper exits', async () => {
    const window = sender();
    await call('model:speech-start', window, 'en-US');
    for (const exit of main.exits) {
      exit();
    }
    expect(window.lost).toEqual([{ session: 1 }]);
    // Gone with it: a new helper's late words or a later finish find nothing here.
    helperSays({ session: 1, source: 'quick', text: 'Lunch' });
    expect(window.sent).toEqual([]);
  });
});
