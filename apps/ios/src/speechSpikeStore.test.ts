import { describe, expect, it } from 'vite-plus/test';
import type { SpikeClip } from './speechSpikeClips.ts';
import {
  createSpeechSpikeStore,
  type ParakeetPort,
  type SpeechSpikeDeps,
} from './speechSpikeStore.ts';

const CLIPS: ReadonlyArray<SpikeClip> = [
  {
    group: 'en',
    id: 'place-en-07',
    lang: 'en',
    path: 'places/place-en-07.m4a',
    people: [],
    place: 'Karlsplatz',
    said: 'Concert at Karlsplatz next Thursday at eight',
  },
  {
    group: 'turns',
    id: 'turn-16',
    lang: 'en',
    path: 'turns/turn-16.m4a',
    people: ['Jörg Hofstätter'],
    said: 'without Jörg Hofstätter',
  },
];

const HEARD: Readonly<Record<string, string>> = {
  'file:///places/place-en-07.m4a': 'Concert at Karlsplatz next Thursday at eight.',
  'file:///turns/turn-16.m4a': 'Without Jörg Hofstädter.',
};

const setup = (over: Partial<SpeechSpikeDeps> = {}) => {
  const log: Array<string> = [];
  let footprint = 100;
  const parakeet: ParakeetPort = {
    load: async (version, vocabulary, onProgress) => {
      log.push(`load ${version} [${vocabulary.join(', ')}]`);
      onProgress(0.5);
      footprint += 50;
      return { loadMs: 1200 };
    },
    release: async () => {
      log.push('release');
      footprint -= 50;
    },
    transcribe: async (uri) => {
      log.push(`transcribe ${uri}`);
      const text = HEARD[uri] ?? '';
      return { audioSeconds: 3, ms: 40, raw: text, replacements: [], rescoreMs: 0, text };
    },
  };
  const deps: SpeechSpikeDeps = {
    assistant: async () => {
      log.push('assistant');
      footprint += 900;
    },
    clips: CLIPS,
    files: {
      fetch: async (clip) => {
        log.push(`fetch ${clip.path}`);
        return `file:///${clip.path}`;
      },
      share: async (name, text) => {
        log.push(`share ${name} ${String(text.length > 0)}`);
      },
    },
    keepAwake: (on) => log.push(`awake ${String(on)}`),
    memory: () => ({ available: 3000 - footprint, footprint, physical: 8000 }),
    now: () => Date.parse('2026-11-23T17:00:00Z'),
    parakeet,
    people: ['Jörg Hofstätter', 'Sarah'],
    platform: 'ios 27.2',
    simulator: false,
    ...over,
  };
  return { log, store: createSpeechSpikeStore(deps) };
};

describe('createSpeechSpikeStore', () => {
  it('fetches the clips, loads the Assistant then Parakeet, runs every clip, scores and lets go', async () => {
    const { log, store } = setup();
    await store.run();
    expect(log).toEqual([
      'awake true',
      'fetch places/place-en-07.m4a',
      'fetch turns/turn-16.m4a',
      'assistant',
      'load ultra [Jörg Hofstätter, Sarah]',
      'transcribe file:///places/place-en-07.m4a',
      'transcribe file:///turns/turn-16.m4a',
      'release',
      'awake false',
    ]);
    const { report, step } = store.getState();
    expect(step).toEqual({ kind: 'idle' });
    expect(report?.cut).toBeUndefined();
    expect(report?.memory).toEqual({
      afterAssistant: 1000,
      afterLoad: 1050,
      before: 100,
      leastAvailable: 1950,
      peak: 1050,
      physical: 8000,
    });
    expect(report?.scores.en).toEqual({
      clips: 1,
      people: { named: 0, right: 0 },
      places: { named: 1, right: 1 },
      wordErrorRate: 0,
    });
    // "Hofstädter" is not the name, and one word of three is wrong.
    expect(report?.scores.turns.people).toEqual({ named: 1, right: 0 });
    expect(report?.scores.turns.wordErrorRate).toBeCloseTo(1 / 3);
    expect(report?.rows.map((row) => row.id)).toEqual(['place-en-07', 'turn-16']);
    expect(report?.timing).toEqual({ medianMs: 40, p90Ms: 40 });

    await store.share();
    expect(log.at(-1)).toBe('share speech-spike-ultra-20261123T170000.json true');
  });

  it('loads Parakeet alone and with no vocabulary when asked', async () => {
    const { log, store } = setup();
    store.setOptions({ beside: false, version: 'v3', vocabulary: 'none' });
    await store.run();
    expect(log).not.toContain('assistant');
    expect(log).toContain('load v3 []');
    expect(store.getState().report?.memory.afterAssistant).toBeUndefined();
  });

  it('keeps what it measured when the app leaves the screen mid-run', async () => {
    const { store } = setup();
    const first = { done: false };
    const unsubscribe = store.subscribe(() => {
      const { step } = store.getState();
      if (step.kind === 'running' && step.done === 1 && !first.done) {
        first.done = true;
        store.interrupt();
      }
    });
    await store.run();
    unsubscribe();
    const { report } = store.getState();
    expect(report?.cut).toBe('The app left the screen.');
    expect(report?.rows.map((row) => row.id)).toEqual(['place-en-07']);
    // The turns never ran: no score, not a perfect one.
    expect(report?.scores.turns).toEqual({
      clips: 0,
      people: { named: 0, right: 0 },
      places: { named: 0, right: 0 },
      wordErrorRate: undefined,
    });
  });

  it('says the app left the screen where that aborted a clip’s download', async () => {
    const { store } = setup({
      files: {
        fetch: async (_clip, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('The operation was aborted.')));
            store.interrupt();
          }),
        share: async () => {},
      },
    });
    await store.run();
    expect(store.getState().notice).toBe('The app left the screen.');
    expect(store.getState().step).toEqual({ kind: 'idle' });
  });

  it('counts the memory warnings iOS sent while it ran', async () => {
    const { store } = setup();
    const warned = { done: false };
    const unsubscribe = store.subscribe(() => {
      if (store.getState().step.kind === 'running' && !warned.done) {
        warned.done = true;
        store.memoryWarning();
      }
    });
    store.memoryWarning();
    await store.run();
    unsubscribe();
    expect(store.getState().report?.memoryWarnings).toBe(1);
  });

  it('says why where the Assistant’s model cannot load, and lets Parakeet go anyway', async () => {
    const { log, store } = setup({
      assistant: async () => {
        throw new Error('The Assistant’s model is not downloaded.');
      },
    });
    await store.run();
    expect(store.getState().notice).toBe('The Assistant’s model is not downloaded.');
    expect(store.getState().report).toBeUndefined();
    expect(log.slice(-2)).toEqual(['release', 'awake false']);
  });

  it('does nothing on a binary without the module', async () => {
    const { log, store } = setup({ parakeet: undefined });
    await store.run();
    expect(log).toEqual([]);
  });

  it('keeps the vocabulary’s first reading where it changed the words', async () => {
    const { store } = setup({
      parakeet: {
        load: async () => ({ loadMs: 1 }),
        release: async () => {},
        transcribe: async () => ({
          audioSeconds: 1,
          ms: 1,
          raw: 'Without Jörg Hofstädter.',
          replacements: [{ from: 'Hofstädter', to: 'Hofstätter' }],
          rescoreMs: 1,
          text: 'Without Jörg Hofstätter.',
        }),
      },
    });
    await store.run();
    const row = store.getState().report?.rows[1];
    expect(row?.raw).toBe('Without Jörg Hofstädter.');
    expect(store.getState().report?.rows[0]?.raw).toBe('Without Jörg Hofstädter.');
  });
});
