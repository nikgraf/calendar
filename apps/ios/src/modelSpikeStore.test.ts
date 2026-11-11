import { describe, expect, it } from 'vite-plus/test';
import { SPIKE_MODELS, type SpikeModel } from './modelSpike.ts';
import { createSpikeStore, type SpikeDeps, type SpikeFiles } from './modelSpikeStore.ts';
import type { OpenModelContext, OpenModelRuntime } from './openModel.ts';

const [LFM] = SPIKE_MODELS as [SpikeModel];

const noop = (): void => undefined;

/** How many times the model was asked, by the log. */
const completions = (log: ReadonlyArray<string>): number =>
  log.filter((line) => line === 'completion').length;

const CASES = [
  { id: 'dinner', lang: 'en' as const, text: 'Dinner with Teo on Friday at 7pm' },
  { id: 'dentist', lang: 'en' as const, text: 'Dentist on Friday at 9am' },
];

/** Holds a context's answers back from the `from`-th call on, until `wait` is released. */
interface Gate {
  readonly from: number;
  readonly wait: Promise<void>;
}

/** A context that answers every prompt with a Friday dinner. */
const context = (log: Array<string>, gate?: Gate): OpenModelContext => {
  let asked = 0;
  return contextOf(log, async () => {
    asked += 1;
    if (gate !== undefined && asked >= gate.from) {
      await gate.wait;
    }
  });
};

const contextOf = (log: Array<string>, before: () => Promise<void>): OpenModelContext => ({
  completion: async () => {
    log.push('completion');
    await before();
    return {
      text: '{"date":"2026-11-13","startTime":"19:00","title":"Dinner with Teo"}',
      timings: { predicted_ms: 400, predicted_n: 20, prompt_ms: 200, prompt_n: 300 },
      tokens_evaluated: 300,
    };
  },
  gpu: false,
  model: { desc: 'LFM3 1.7B Q4_K_M', nParams: 1_700_000_000, size: LFM.bytes },
  reasonNoGPU: 'Metal is not supported in the simulator',
  release: async () => {
    log.push('released');
  },
  // As llama.rn answered on the simulator: nothing, not a promise.
  stopCompletion: () => {
    log.push('completion stopped');
    return undefined;
  },
});

/**
 * A device with the model file stored, a clock that moves a second per
 * read, and memory that grows by a model on every load and by a megabyte
 * on every read after it.
 */
const device = (over: Partial<SpikeDeps> = {}, gate?: Gate) => {
  const log: Array<string> = [];
  const stored = new Map<string, number>([[LFM.file, LFM.bytes]]);
  let time = 0;
  let footprint = 200_000_000;
  let loads = 0;
  const files: SpikeFiles = {
    download: async (model, onProgress) => {
      onProgress(model.bytes / 2);
      stored.set(model.file, model.bytes - 1);
      return model.bytes - 1;
    },
    pathOf: (model) => `file:///documents/model-spike/${model.file}`,
    remove: (model) => {
      stored.delete(model.file);
    },
    share: async (name, text) => {
      log.push(`shared ${name} ${String(text.length > 0)}`);
    },
    sizeOf: (model) => stored.get(model.file),
  };
  const runtime: OpenModelRuntime = {
    initLlama: async (params, onProgress) => {
      log.push(`init ${String(params['model'])} gpu layers ${String(params['n_gpu_layers'])}`);
      onProgress?.(50);
      footprint += 1_200_000_000;
      loads += 1;
      return context(log, gate);
    },
  };
  const store = createSpikeStore({
    cases: CASES,
    files,
    keepAwake: (on) => {
      log.push(`awake ${String(on)}`);
    },
    memory: () => {
      footprint += loads > 0 ? 1_000_000 : 0;
      return { available: 0, footprint, physical: 8_000_000_000 };
    },
    now: () => {
      time += 1000;
      return time;
    },
    platform: 'ios 27.1',
    runtime,
    simulator: true,
    today: () => '2026-11-11',
    ...over,
  });
  return { log, store };
};

describe('createSpikeStore', () => {
  it('loads a stored model, runs the phrases with the screen kept on, and reports', async () => {
    const { log, store } = device();
    const steps: Array<string> = [];
    store.subscribe(() => steps.push(store.getState().step.kind));
    store.refresh();
    expect(store.getState().stored).toEqual({ [LFM.file]: LFM.bytes });

    await store.load(LFM);
    expect(store.getState().step).toMatchObject({
      kind: 'loaded',
      loaded: {
        footprintBefore: 200_000_000,
        loadMs: 1000,
        memory: { footprint: 1_401_000_000 },
      },
    });

    await store.run(1);
    expect(store.getState().step.kind).toBe('loaded');
    expect(store.getState()).toMatchObject({
      report: {
        asked: 1,
        gpu: false,
        loadMs: 1000,
        memory: {
          footprintBefore: 200_000_000,
          footprintLoaded: 1_401_000_000,
          // Read again after the phrase: the highest seen, not the loaded one.
          footprintPeak: 1_402_000_000,
          physical: 8_000_000_000,
        },
        model: { name: 'LFM3 1.7B' },
        modelDescription: 'LFM3 1.7B Q4_K_M',
        platform: 'ios 27.1',
        rows: [{ id: 'dinner', result: { kind: 'parsed' } }],
        simulator: true,
        summary: { parsed: 1, turns: 1 },
        timeZone: 'Europe/Vienna',
        today: '2026-11-11',
      },
    });
    expect(log).toEqual([
      `init file:///documents/model-spike/${LFM.file} gpu layers 99`,
      'awake true',
      'completion',
      'awake false',
    ]);
    expect(steps).toContain('loading');
    expect(steps).toContain('running');

    await store.share();
    expect(log.at(-1)).toMatch(
      /^shared model-spike-LFM3-1\.7B-Q4_K_M\.gguf-\d{8}T\d{6}\.json true$/u,
    );
    await store.unload();
    expect(log.at(-1)).toBe('released');
    expect(store.getState().step).toEqual({ kind: 'idle' });
  });

  it('stops a run between phrases and keeps the rows so far', async () => {
    const { store } = device();
    await store.load(LFM);
    store.subscribe(() => {
      const { step } = store.getState();
      if (step.kind === 'running' && step.rows.length === 1) {
        store.stopRun();
      }
    });
    await store.run(2);
    expect(store.getState()).toMatchObject({
      report: { asked: 2, summary: { turns: 1 } },
      step: { kind: 'loaded' },
    });
  });

  it('keeps the loaded model through a download nobody may start, and unloads once', async () => {
    const { log, store } = device();
    const [, qwen] = SPIKE_MODELS as [SpikeModel, SpikeModel];
    await store.load(LFM);
    // One model at a time: a download would take the step and lose the context without releasing it.
    await store.fetchModel(qwen);
    await store.load(qwen);
    store.refresh();
    expect(store.getState().step).toMatchObject({ kind: 'loaded', loaded: { model: LFM } });
    expect(store.getState().stored).toEqual({ [LFM.file]: LFM.bytes });
    expect(log.filter((line) => line.startsWith('init'))).toHaveLength(1);

    // While the context is on its way out nothing runs on it, and a second Unload is one release.
    const first = store.unload();
    expect(store.getState().step).toEqual({ kind: 'unloading', model: LFM });
    await store.run(1);
    await store.unload();
    await first;
    expect(store.getState().step).toEqual({ kind: 'idle' });
    expect(log.filter((line) => line === 'released')).toHaveLength(1);
    expect(log).not.toContain('awake true');
  });

  it('cuts a run short when the app leaves the screen, and keeps what was measured before', async () => {
    let open: () => void = noop;
    // The first phrase is answered; the second is under way when the app leaves.
    const gate = {
      from: 2,
      wait: new Promise<void>((resolve) => {
        open = resolve;
      }),
    };
    const { log, store } = device({}, gate);
    await store.load(LFM);
    const stop = store.subscribe(() => {
      const { step } = store.getState();
      if (step.kind === 'running' && step.rows.length === 1) {
        stop();
        void (async () => {
          // Once the second phrase has reached the model.
          for (let turn = 0; turn < 1000 && completions(log) < 2; turn += 1) {
            await Promise.resolve();
          }
          store.interrupt();
          open();
        })();
      }
    });
    await store.run(2);
    expect(store.getState()).toMatchObject({
      notice:
        'The run stopped after 1 of 2 phrases because the app left the screen, and the model was unloaded. Load it again to run.',
      // The phrase that was cut short is left out; the one before it is still there to read and share.
      report: { asked: 2, rows: [{ id: 'dinner' }], summary: { turns: 1 } },
      step: { kind: 'idle' },
    });
    expect(log.slice(1)).toEqual([
      'awake true',
      'completion',
      'completion',
      'completion stopped',
      'awake false',
      'released',
    ]);
    await store.share();
    expect(log.at(-1)).toMatch(/^shared model-spike-/u);
    // Loaded and idle, the model stays: nothing computes in the background.
    await store.load(LFM);
    store.interrupt();
    expect(store.getState().step.kind).toBe('loaded');
  });

  it('asks the model nothing more once the app has left the screen', async () => {
    let open: () => void = noop;
    const gate = {
      from: 1,
      wait: new Promise<void>((resolve) => {
        open = resolve;
      }),
    };
    // A phrase that invites someone asks twice: who is invited, and the extraction beside it.
    const { log, store } = device(
      {
        cases: [
          { id: 'invite', lang: 'en', text: 'Lunch tomorrow at noon, invite Tom Baker' },
          { id: 'dinner', lang: 'en', text: 'Dinner with Teo on Friday at 7pm' },
        ],
      },
      gate,
    );
    await store.load(LFM);
    const run = store.run(2);
    await Promise.resolve();
    await Promise.resolve();
    store.interrupt();
    open();
    await run;
    // One completion had begun; the one queued behind it never reached the model.
    expect(completions(log)).toBe(1);
    expect(store.getState()).toMatchObject({ report: { rows: [] }, step: { kind: 'idle' } });
  });

  it(
    'goes on stopping until the run has wound down: a stop before the completion begins is lost',
    { timeout: 2000 },
    async () => {
      const log: Array<string> = [];
      let stops = 0;
      let heard: () => void = noop;
      // As llama.rn does it: a completion clears a stop that came before it began, so only the second ends it.
      const secondStop = new Promise<void>((resolve) => {
        heard = resolve;
      });
      const { store } = device({
        runtime: {
          initLlama: async () => ({
            ...contextOf(log, () => secondStop),
            stopCompletion: () => {
              stops += 1;
              if (stops === 2) {
                heard();
              }
              return undefined;
            },
          }),
        },
      });
      await store.load(LFM);
      const run = store.run(1);
      // The completion is under way, and it ends only on the second stop.
      for (let turn = 0; turn < 1000 && completions(log) < 1; turn += 1) {
        await Promise.resolve();
      }
      // Told once: the store itself has to stop again.
      store.interrupt();
      await run;
      expect(stops).toBeGreaterThanOrEqual(2);
      expect(store.getState().step).toEqual({ kind: 'idle' });
      // And it stops stopping once the run is over.
      const after = stops;
      await new Promise((resolve) => {
        setTimeout(resolve, 150);
      });
      expect(stops).toBe(after);
    },
  );

  it('unloads a model again when the app left the screen while it was loading', async () => {
    let open: () => void = noop;
    const loading = new Promise<void>((resolve) => {
      open = resolve;
    });
    const log: Array<string> = [];
    const { store } = device({
      runtime: {
        initLlama: async () => {
          await loading;
          return context(log);
        },
      },
    });
    const load = store.load(LFM);
    store.interrupt();
    open();
    await load;
    // A load computes on the GPU too; whether it was refused cannot be told, so the context is not kept.
    expect(log).toEqual(['released']);
    expect(store.getState()).toMatchObject({
      notice:
        'The app left the screen while the model was loading, so it was unloaded again. Load it once more and stay on the page.',
      step: { kind: 'idle' },
    });
    // The next load is its own: nothing of the interruption is left over.
    await store.load(LFM);
    expect(store.getState().step.kind).toBe('loaded');
  });

  it('lets the screen lock again and keeps the model when a run throws', async () => {
    const { log, store } = device({
      today: () => {
        throw new Error('unreachable');
      },
    });
    await store.load(LFM);
    await expect(store.run(1)).rejects.toThrow('unreachable');
    // Thrown before the run began: nothing was switched on.
    expect(log).not.toContain('awake true');
    const failing = device({
      keepAwake: (on) => {
        log.push(`awake ${String(on)}`);
      },
      now: (() => {
        let reads = 0;
        return () => {
          reads += 1;
          if (reads === 4) {
            throw new Error('clock failed');
          }
          return reads * 1000;
        };
      })(),
    });
    await failing.store.load(LFM);
    await failing.store.run(1);
    expect(failing.store.getState()).toMatchObject({
      notice: 'The run failed: clock failed',
      report: { rows: [] },
      step: { kind: 'loaded' },
    });
    expect(log.slice(-2)).toEqual(['awake true', 'awake false']);
  });

  it('says when a download is not the file that was expected, and when loading fails', async () => {
    const { store } = device({
      runtime: {
        initLlama: async () => {
          throw new Error('failed to load model');
        },
      },
    });
    const [, qwen] = SPIKE_MODELS as [SpikeModel, SpikeModel];
    await store.fetchModel(qwen);
    expect(store.getState()).toMatchObject({
      notice: `${qwen.file} is ${String(qwen.bytes - 1)} bytes, not the ${String(qwen.bytes)} expected: the file at that address changed, or the download was cut short.`,
      step: { kind: 'idle' },
      stored: { [qwen.file]: qwen.bytes - 1 },
    });
    await store.load(LFM);
    expect(store.getState()).toMatchObject({
      notice: 'Loading failed: failed to load model',
      step: { kind: 'idle' },
    });
    store.removeModel(qwen);
    expect(store.getState().stored).toEqual({ [LFM.file]: LFM.bytes });
  });

  it('does nothing without the runtime or the files: a build that has neither', async () => {
    const { store } = device({ files: undefined, runtime: undefined });
    await store.fetchModel(LFM);
    await store.load(LFM);
    await store.run(1);
    expect(store.getState()).toMatchObject({ notice: undefined, step: { kind: 'idle' } });
  });
});
