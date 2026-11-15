import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { languageName, noiseReduction } from './dictationSettings.ts';

type StorageHandler = (event: { readonly key: string | null }) => void;

/** The renderer's storage, which both windows share, and the other window's `storage` events. */
const page = () => {
  const stored = new Map<string, string>();
  const handlers = new Set<StorageHandler>();
  vi.stubGlobal('window', {
    addEventListener: (_type: 'storage', handler: StorageHandler) => handlers.add(handler),
    localStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => {
        stored.set(key, value);
      },
    },
    removeEventListener: (_type: 'storage', handler: StorageHandler) => handlers.delete(handler),
  });
  return {
    /** The Settings window wrote: this window hears of it only through the event. */
    fromOtherWindow: (key: string, value: string) => {
      stored.set(key, value);
      for (const handler of handlers) {
        handler({ key });
      }
    },
    handlers,
    stored,
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('noiseReduction', () => {
  it('is on until this Mac turns it off, then stays as chosen', () => {
    const { stored } = page();
    expect(noiseReduction.get()).toBe(true);
    noiseReduction.set(false);
    expect(stored.get('dictation.reduceNoise')).toBe('off');
    expect(noiseReduction.get()).toBe(false);
    noiseReduction.set(true);
    expect(noiseReduction.get()).toBe(true);
  });

  it('records as before when there is nowhere to keep a choice', () => {
    vi.stubGlobal('window', {});
    expect(noiseReduction.get()).toBe(true);
    expect(() => noiseReduction.set(false)).not.toThrow();
  });

  it('tells a subscriber of this window’s choices and the other window’s, until it leaves', () => {
    const { fromOtherWindow, handlers } = page();
    const heard: Array<boolean> = [];
    const stop = noiseReduction.subscribe(() => heard.push(noiseReduction.get()));
    noiseReduction.set(false);
    fromOtherWindow('dictation.reduceNoise', 'on');
    fromOtherWindow('settings.lastPane', 'model');
    stop();
    noiseReduction.set(false);
    expect(heard).toEqual([false, true]);
    expect(handlers.size).toBe(0);
  });
});

describe('languageName', () => {
  it('names a locale in English, the standard way rather than the dialect', () => {
    expect(languageName('en-US')).toBe('English (United States)');
    expect(languageName('de-AT')).toBe('German (Austria)');
  });
});
