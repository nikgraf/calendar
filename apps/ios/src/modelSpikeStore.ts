import {
  runSpike,
  SPIKE_MODELS,
  SPIKE_TIME_ZONE,
  type SpikeModel,
  type SpikeReport,
  type SpikeRow,
  summarize,
} from './modelSpike.ts';
import type { SpikeCase } from './modelSpikeCases.ts';
import {
  loadOpenModel,
  type OpenModelContext,
  type OpenModelRuntime,
  openLanguageModel,
} from './openModel.ts';

/**
 * The Model Spike page's state and what its buttons do, kept apart from
 * React and from the native modules so it runs in a test: the page hands
 * in the files, the runtime, the memory reader and the clock, and draws
 * what `getState` says.
 */

/** How often the footprint is read while phrases run: a peak inside a completion is seen, not only after it. */
const MEMORY_SAMPLE_MS = 500;

/** The process's memory in bytes (`solunivo-process-memory`). */
export interface DeviceMemory {
  readonly available: number;
  readonly footprint: number;
  readonly physical: number;
}

/** The model files in the app's documents. */
export interface SpikeFiles {
  /** Fetches the file and answers its size; rejects when the fetch fails or is stopped. */
  readonly download: (
    model: SpikeModel,
    onProgress: (received: number) => void,
    signal: AbortSignal,
  ) => Promise<number>;
  /** Where the runtime reads the file from. */
  readonly pathOf: (model: SpikeModel) => string;
  readonly remove: (model: SpikeModel) => void;
  /** Hands a text file to the share sheet. */
  readonly share: (name: string, text: string) => Promise<void>;
  /** The file's size, or undefined when it is not here. */
  readonly sizeOf: (model: SpikeModel) => number | undefined;
}

export interface SpikeDeps {
  readonly cases: ReadonlyArray<SpikeCase>;
  /** Undefined on a binary without the file system module. */
  readonly files: SpikeFiles | undefined;
  /** Keeps the screen on through a run, and lets it lock again. */
  readonly keepAwake: (on: boolean) => void;
  readonly memory: () => DeviceMemory | undefined;
  readonly now: () => number;
  /** `ios 27.1`, for the report. */
  readonly platform: string;
  /** Undefined on a binary built without llama.rn. */
  readonly runtime: OpenModelRuntime | undefined;
  /** A simulator runs the app: its timings are not a phone's. */
  readonly simulator: boolean;
  /** Today in `SPIKE_TIME_ZONE`, `YYYY-MM-DD`. */
  readonly today: () => string;
}

/** A model in memory, and what it took to get it there. */
export interface LoadedModel {
  readonly context: OpenModelContext;
  readonly footprintBefore: number;
  readonly loadMs: number;
  readonly memory: DeviceMemory | undefined;
  readonly model: SpikeModel;
}

/** Where the page is: one model at most is in memory, and one thing at most is under way. */
export type SpikeStep =
  | { readonly kind: 'idle' }
  | { readonly kind: 'downloading'; readonly model: SpikeModel; readonly received: number }
  | { readonly kind: 'loading'; readonly model: SpikeModel; readonly percent: number }
  | {
      readonly kind: 'loaded';
      readonly loaded: LoadedModel;
      readonly report?: SpikeReport | undefined;
    }
  | {
      readonly kind: 'running';
      readonly loaded: LoadedModel;
      readonly rows: ReadonlyArray<SpikeRow>;
      readonly total: number;
    }
  | { readonly kind: 'unloading'; readonly model: SpikeModel };

export interface SpikeState {
  readonly memory: DeviceMemory | undefined;
  /** Why the last action did not do what was asked. */
  readonly notice: string | undefined;
  readonly step: SpikeStep;
  /** The size of each model file that is here, by file name. */
  readonly stored: Readonly<Record<string, number>>;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Takes a context out of memory; what went wrong, if anything. */
const release = async (loaded: LoadedModel): Promise<string | undefined> => {
  try {
    await loaded.context.release();
    return undefined;
  } catch (error) {
    return `Unloading failed: ${messageOf(error)}`;
  }
};

export const createSpikeStore = (deps: SpikeDeps) => {
  const listeners = new Set<() => void>();
  let stopRun = false;
  // The app left the screen mid-run: the phrase under way is cut short and the model unloaded.
  let interrupted = false;
  let download: AbortController | undefined;

  const storedNow = (): Readonly<Record<string, number>> =>
    Object.fromEntries(
      SPIKE_MODELS.flatMap((model) => {
        const size = deps.files?.sizeOf(model);
        return size === undefined ? [] : [[model.file, size] as const];
      }),
    );

  let state: SpikeState = {
    memory: undefined,
    notice: undefined,
    step: { kind: 'idle' },
    stored: {},
  };

  const set = (next: Partial<SpikeState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) {
      listener();
    }
  };

  return {
    /**
     * Fetches a model file into the app's caches. Only with nothing loaded
     * and nothing under way: the step is one value, and a download that
     * took it over would lose a loaded model without releasing it.
     */
    fetchModel: async (model: SpikeModel): Promise<void> => {
      const { files } = deps;
      if (!files || !deps.runtime || state.step.kind !== 'idle') {
        return;
      }
      download = new AbortController();
      set({ notice: undefined, step: { kind: 'downloading', model, received: 0 } });
      let notice: string | undefined;
      try {
        const size = await files.download(
          model,
          (received) => set({ step: { kind: 'downloading', model, received } }),
          download.signal,
        );
        if (size !== model.bytes) {
          notice = `${model.file} is ${String(size)} bytes, not the ${String(model.bytes)} expected: the file at that address changed, or the download was cut short.`;
        }
      } catch (error) {
        notice = `Download failed: ${messageOf(error)}`;
      }
      download = undefined;
      set({ notice, step: { kind: 'idle' }, stored: storedNow() });
    },

    getState: (): SpikeState => state,

    /** Loads a stored model into memory, timed, with the memory read before and after. */
    load: async (model: SpikeModel): Promise<void> => {
      const { files, runtime } = deps;
      if (!files || !runtime || state.step.kind !== 'idle') {
        return;
      }
      set({ notice: undefined, step: { kind: 'loading', model, percent: 0 } });
      const footprintBefore = deps.memory()?.footprint ?? 0;
      const started = deps.now();
      try {
        const context = await loadOpenModel(runtime, {
          onProgress: (percent) => set({ step: { kind: 'loading', model, percent } }),
          path: files.pathOf(model),
        });
        const memory = deps.memory();
        set({
          memory,
          step: {
            kind: 'loaded',
            loaded: { context, footprintBefore, loadMs: deps.now() - started, memory, model },
          },
        });
      } catch (error) {
        set({ notice: `Loading failed: ${messageOf(error)}`, step: { kind: 'idle' } });
      }
    },

    /** What the page shows before any button: the files that are here, the memory now. */
    refresh: (): void => {
      set({ memory: deps.memory(), stored: storedNow() });
    },

    /**
     * The app left the screen. iOS ends an app that asks the GPU for work
     * in the background, and a refused command leaves the context unable
     * to compute again, so a run does not go on: the phrase under way is
     * cut short and left out, and the model is unloaded once the run has
     * wound down. A model that is loaded and idle stays.
     */
    interrupt: (): void => {
      if (state.step.kind !== 'running') {
        return;
      }
      interrupted = true;
      stopRun = true;
      const { context } = state.step.loaded;
      // Whatever the stop answers or throws, the run winds down: a phrase that is not cut short runs out.
      const stop = async () => {
        await context.stopCompletion();
      };
      void stop().catch(() => undefined);
    },

    removeModel: (model: SpikeModel): void => {
      const { step } = state;
      const inUse =
        (step.kind === 'loaded' || step.kind === 'running') &&
        step.loaded.model.file === model.file;
      if (inUse || (step.kind !== 'idle' && step.kind !== 'loaded')) {
        return;
      }
      deps.files?.remove(model);
      set({ stored: storedNow() });
    },

    /** The first `count` phrases through the loaded model, then the report. */
    run: async (count: number): Promise<void> => {
      if (state.step.kind !== 'loaded') {
        return;
      }
      const { loaded } = state.step;
      const cases = deps.cases.slice(0, count);
      const today = deps.today();
      stopRun = false;
      interrupted = false;
      set({ notice: undefined, step: { kind: 'running', loaded, rows: [], total: cases.length } });
      deps.keepAwake(true);
      let footprintPeak = loaded.memory?.footprint ?? 0;
      const sample = () => {
        footprintPeak = Math.max(footprintPeak, deps.memory()?.footprint ?? 0);
      };
      const sampling = setInterval(sample, MEMORY_SAMPLE_MS);
      let rows: ReadonlyArray<SpikeRow> = [];
      let failure: string | undefined;
      try {
        rows = await runSpike({
          cases,
          discarded: () => interrupted,
          modelFor: (onCall) => openLanguageModel(loaded.context, onCall),
          now: deps.now,
          onRow: (_row, all) => {
            sample();
            set({ step: { kind: 'running', loaded, rows: [...all], total: cases.length } });
          },
          referenceDate: today,
          stopped: () => stopRun,
        });
      } catch (error) {
        failure = `The run failed: ${messageOf(error)}`;
      } finally {
        clearInterval(sampling);
        deps.keepAwake(false);
      }
      const report: SpikeReport = {
        asked: cases.length,
        gpu: loaded.context.gpu,
        loadMs: loaded.loadMs,
        memory: loaded.memory && {
          availableLoaded: loaded.memory.available,
          footprintBefore: loaded.footprintBefore,
          footprintLoaded: loaded.memory.footprint,
          footprintPeak,
          physical: loaded.memory.physical,
        },
        model: loaded.model,
        modelDescription: loaded.context.model.desc,
        platform: deps.platform,
        reasonNoGpu: loaded.context.reasonNoGPU,
        rows,
        simulator: deps.simulator,
        summary: summarize(rows),
        timeZone: SPIKE_TIME_ZONE,
        today,
        when: new Date(deps.now()).toISOString(),
      };
      if (!interrupted) {
        set({ memory: deps.memory(), notice: failure, step: { kind: 'loaded', loaded, report } });
        return;
      }
      // Nothing may compute on this context again: out it goes. The rows before the cut are kept to read.
      set({ step: { kind: 'unloading', model: loaded.model } });
      const unloadFailure = await release(loaded);
      set({
        memory: deps.memory(),
        notice:
          unloadFailure ??
          `The run stopped after ${String(rows.length)} of ${String(cases.length)} phrases because the app left the screen, and the model was unloaded. Load it again to run.`,
        step: { kind: 'idle' },
      });
    },

    /** The last run's report as a file, to the share sheet. */
    share: async (): Promise<void> => {
      if (state.step.kind !== 'loaded' || !state.step.report || !deps.files) {
        return;
      }
      const { report } = state.step;
      const stamp = report.when.slice(0, 19).replaceAll(/[-:]/gu, '');
      try {
        await deps.files.share(
          `model-spike-${report.model.file}-${stamp}.json`,
          `${JSON.stringify(report, null, 2)}\n`,
        );
      } catch (error) {
        set({ notice: `Sharing failed: ${messageOf(error)}` });
      }
    },

    stopDownload: (): void => {
      download?.abort();
    },

    /** Honoured between phrases: the phrase under way is finished first. */
    stopRun: (): void => {
      stopRun = true;
    },

    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    /** Takes the model out of memory. The step says so while it does: nothing runs on a context on its way out. */
    unload: async (): Promise<void> => {
      if (state.step.kind !== 'loaded') {
        return;
      }
      const { loaded } = state.step;
      set({ step: { kind: 'unloading', model: loaded.model } });
      const notice = await release(loaded);
      set({ memory: deps.memory(), notice, step: { kind: 'idle' } });
    },
  };
};

export type SpikeStore = ReturnType<typeof createSpikeStore>;
