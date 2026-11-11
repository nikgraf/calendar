import { describe, expect, it } from 'vite-plus/test';
import { SPIKE_MODELS, type SpikeModel } from './modelSpike.ts';
import { createSpikeStore, type SpikeDeps, type SpikeFiles } from './modelSpikeStore.ts';
import type { OpenModelContext, OpenModelRuntime } from './openModel.ts';

const [LFM] = SPIKE_MODELS as [SpikeModel];

const CASES = [
  { id: 'dinner', lang: 'en' as const, text: 'Dinner with Teo on Friday at 7pm' },
  { id: 'dentist', lang: 'en' as const, text: 'Dentist on Friday at 9am' },
];

const context = (released: Array<string>): OpenModelContext => ({
  completion: async () => ({
    text: '{"date":"2026-11-13","startTime":"19:00","title":"Dinner with Teo"}',
    timings: { cache_n: 0, predicted_ms: 400, predicted_n: 20, prompt_ms: 200, prompt_n: 300 },
  }),
  gpu: false,
  model: { desc: 'LFM3 1.7B Q4_K_M', nParams: 1_700_000_000, size: LFM.bytes },
  reasonNoGPU: 'Metal is not supported in the simulator',
  release: async () => {
    released.push('released');
  },
});

/** A device with the model file stored, a clock that moves a second per read, and memory that grows on load. */
const device = (over: Partial<SpikeDeps> = {}) => {
  const log: Array<string> = [];
  const stored = new Map<string, number>([[LFM.file, LFM.bytes]]);
  let time = 0;
  let footprint = 200_000_000;
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
      return context(log);
    },
  };
  const store = createSpikeStore({
    cases: CASES,
    files,
    keepAwake: (on) => {
      log.push(`awake ${String(on)}`);
    },
    memory: () => ({ available: 0, footprint, physical: 8_000_000_000 }),
    now: () => {
      time += 1000;
      return time;
    },
    platform: 'ios 27.1',
    runtime,
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
        memory: { footprint: 1_400_000_000 },
      },
    });

    await store.run(1);
    const { step } = store.getState();
    expect(step).toMatchObject({
      kind: 'loaded',
      report: {
        gpu: false,
        loadMs: 1000,
        memory: {
          footprintBefore: 200_000_000,
          footprintLoaded: 1_400_000_000,
          footprintPeak: 1_400_000_000,
          physical: 8_000_000_000,
        },
        model: { name: 'LFM3 1.7B' },
        modelDescription: 'LFM3 1.7B Q4_K_M',
        platform: 'ios 27.1',
        rows: [{ id: 'dinner', result: { kind: 'parsed' } }],
        summary: { parsed: 1, turns: 1 },
        timeZone: 'Europe/Vienna',
        today: '2026-11-11',
      },
    });
    expect(log).toEqual([
      `init file:///documents/model-spike/${LFM.file} gpu layers 99`,
      'awake true',
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
    expect(store.getState().step).toMatchObject({
      kind: 'loaded',
      report: { summary: { turns: 1 } },
    });
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
