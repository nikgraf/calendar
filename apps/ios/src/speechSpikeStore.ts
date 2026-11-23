import type { ParakeetHeard, ParakeetVersion } from '../modules/solunivo-parakeet/index.ts';
import type { SpikeClip } from './speechSpikeClips.ts';
import { type GroupScore, scoreClip, scoreGroup } from './speechSpikeScore.ts';
import type { DeviceMemory } from './modelSpikeStore.ts';

/**
 * The Speech Spike page's state and its one action, kept apart from React
 * and the native modules so it runs in a test. A run fetches Nik's
 * recordings (once), loads the Assistant's model if asked, loads Parakeet,
 * transcribes every clip and scores it against the sheet, reading the
 * app's memory throughout, then lets Parakeet go. Measured, nothing more:
 * no dictation uses Parakeet.
 */

/** How often the footprint is read while a model loads and clips run. */
const MEMORY_SAMPLE_MS = 500;

/** The recordings in the app's caches. */
export interface ClipFiles {
  /** Fetches the clip unless it is here, and answers where it is. */
  readonly fetch: (clip: SpikeClip, signal: AbortSignal) => Promise<string>;
  /** Hands a text file to the share sheet. */
  readonly share: (name: string, text: string) => Promise<void>;
}

/** `solunivo-parakeet`, as the store calls it. */
export interface ParakeetPort {
  readonly load: (
    version: ParakeetVersion,
    vocabulary: ReadonlyArray<string>,
    onProgress: (fraction: number) => void,
  ) => Promise<{ readonly loadMs: number }>;
  readonly release: () => Promise<void>;
  readonly transcribe: (uri: string) => Promise<ParakeetHeard>;
}

export interface SpeechSpikeDeps {
  /** Loads the Assistant's own model into the app; rejects where it is not here. */
  readonly assistant: (() => Promise<void>) | undefined;
  readonly clips: ReadonlyArray<SpikeClip>;
  /** Undefined on a binary without the file system module. */
  readonly files: ClipFiles | undefined;
  readonly keepAwake: (on: boolean) => void;
  readonly memory: () => DeviceMemory | undefined;
  readonly now: () => number;
  /** Undefined on a binary built without `solunivo-parakeet`. */
  readonly parakeet: ParakeetPort | undefined;
  /** The people's names, the vocabulary when one is asked for. */
  readonly people: ReadonlyArray<string>;
  /** `ios 27.1`, for the report. */
  readonly platform: string;
  /** A simulator runs the app: its timings and memory are the Mac's. */
  readonly simulator: boolean;
}

export interface SpeechSpikeOptions {
  /** Load the Assistant's model first, so the memory read is of both. */
  readonly beside: boolean;
  readonly version: ParakeetVersion;
  readonly vocabulary: 'none' | 'people';
}

export interface SpeechSpikeRow extends Omit<ParakeetHeard, 'raw'> {
  readonly group: SpikeClip['group'];
  readonly id: string;
  /** Before the vocabulary's rescoring, where it changed anything. */
  readonly raw?: string;
}

/** The app's footprint at each point of a run, in bytes. */
export interface RunMemory {
  readonly afterAssistant: number | undefined;
  readonly afterLoad: number | undefined;
  readonly before: number | undefined;
  /** The least the app could still take before iOS ends it (0 on a simulator). */
  readonly leastAvailable: number | undefined;
  readonly peak: number | undefined;
  readonly physical: number | undefined;
}

export interface SpeechSpikeReport {
  /** The app left the screen, or a clip failed, before every clip ran. */
  readonly cut?: string;
  readonly loadMs: number;
  readonly memory: RunMemory;
  readonly options: SpeechSpikeOptions;
  readonly platform: string;
  readonly rows: ReadonlyArray<SpeechSpikeRow>;
  readonly scores: Readonly<Record<SpikeClip['group'], GroupScore>>;
  readonly simulator: boolean;
  readonly timing: { readonly medianMs: number; readonly p90Ms: number };
  readonly when: string;
}

export type SpeechSpikeStep =
  | { readonly kind: 'idle' }
  | { readonly done: number; readonly kind: 'fetching'; readonly total: number }
  | { readonly kind: 'assistant' }
  | { readonly fraction: number; readonly kind: 'loading' }
  | { readonly done: number; readonly kind: 'running'; readonly total: number };

export interface SpeechSpikeState {
  readonly memory: DeviceMemory | undefined;
  /** Why the last run did not do what was asked. */
  readonly notice: string | undefined;
  readonly options: SpeechSpikeOptions;
  /** The last run that ended, until the next one starts. */
  readonly report: SpeechSpikeReport | undefined;
  readonly step: SpeechSpikeStep;
}

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The value at the `share` of the way up the sorted values (0.5: the median). */
const quantile = (values: ReadonlyArray<number>, share: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0;
};

/** The footprint's highest and the least left, read every `MEMORY_SAMPLE_MS` while a run is under way. */
const memoryWatch = (read: () => DeviceMemory | undefined) => {
  let peak: number | undefined;
  let leastAvailable: number | undefined;
  const sample = () => {
    const now = read();
    if (now === undefined) {
      return undefined;
    }
    peak = Math.max(peak ?? 0, now.footprint);
    leastAvailable = Math.min(leastAvailable ?? Number.POSITIVE_INFINITY, now.available);
    return now;
  };
  const timer = setInterval(sample, MEMORY_SAMPLE_MS);
  return {
    sample,
    stop: () => {
      clearInterval(timer);
      sample();
      return { leastAvailable, peak };
    },
  };
};

export const scoresOf = (
  clips: ReadonlyArray<SpikeClip>,
  rows: ReadonlyArray<SpeechSpikeRow>,
): Readonly<Record<SpikeClip['group'], GroupScore>> => {
  const scored = rows.flatMap((row) => {
    const clip = clips.find((each) => each.id === row.id);
    return clip === undefined ? [] : [{ group: clip.group, score: scoreClip(clip, row.text) }];
  });
  const of = (group: SpikeClip['group']) =>
    scoreGroup(scored.filter((each) => each.group === group).map((each) => each.score));
  return { de: of('de'), en: of('en'), turns: of('turns') };
};

export const createSpeechSpikeStore = (deps: SpeechSpikeDeps) => {
  const listeners = new Set<() => void>();
  let cut: string | undefined;
  let fetching: AbortController | undefined;

  let state: SpeechSpikeState = {
    memory: undefined,
    notice: undefined,
    options: { beside: true, version: 'ultra', vocabulary: 'people' },
    report: undefined,
    step: { kind: 'idle' },
  };

  const set = (next: Partial<SpeechSpikeState>) => {
    state = { ...state, ...next };
    for (const listener of listeners) {
      listener();
    }
  };

  /** Every clip here, fetched where it is not; undefined where the run was cut while fetching. */
  const fetchClips = async (files: ClipFiles): Promise<ReadonlyArray<string> | undefined> => {
    fetching = new AbortController();
    const uris: Array<string> = [];
    for (const clip of deps.clips) {
      set({ step: { done: uris.length, kind: 'fetching', total: deps.clips.length } });
      // One at a time: a phone may be on mobile data, and the count shows it.
      uris.push(await files.fetch(clip, fetching.signal));
      if (cut !== undefined) {
        return undefined;
      }
    }
    fetching = undefined;
    return uris;
  };

  /** Every clip through Parakeet, in the sheet's order, until the run is cut. */
  const transcribeAll = async (
    parakeet: ParakeetPort,
    uris: ReadonlyArray<string>,
  ): Promise<ReadonlyArray<SpeechSpikeRow>> => {
    const rows: Array<SpeechSpikeRow> = [];
    for (const [index, clip] of deps.clips.entries()) {
      set({ step: { done: rows.length, kind: 'running', total: deps.clips.length } });
      // Asked after the count is shown: a listener may cut the run in answer to it.
      if (cut !== undefined) {
        break;
      }
      try {
        // One clip at a time: each is timed on its own.
        const heard = await parakeet.transcribe(uris[index] ?? '');
        const { raw, ...rest } = heard;
        rows.push({
          ...rest,
          group: clip.group,
          id: clip.id,
          ...(raw === heard.text ? {} : { raw }),
        });
      } catch (error) {
        cut = `${clip.id} failed: ${messageOf(error)}`;
      }
    }
    return rows;
  };

  const run = async (): Promise<void> => {
    const { files, parakeet } = deps;
    if (files === undefined || parakeet === undefined || state.step.kind !== 'idle') {
      return;
    }
    const { options } = state;
    cut = undefined;
    set({ notice: undefined, report: undefined });
    deps.keepAwake(true);
    const watch = memoryWatch(deps.memory);
    try {
      const uris = await fetchClips(files);
      if (uris === undefined) {
        set({ notice: cut });
        return;
      }
      const before = watch.sample()?.footprint;
      let afterAssistant: number | undefined;
      if (options.beside) {
        set({ step: { kind: 'assistant' } });
        if (deps.assistant === undefined) {
          throw new Error('This build cannot load the Assistant’s model.');
        }
        await deps.assistant();
        afterAssistant = watch.sample()?.footprint;
      }
      set({ step: { fraction: 0, kind: 'loading' } });
      const { loadMs } = await parakeet.load(
        options.version,
        options.vocabulary === 'people' ? deps.people : [],
        (fraction) => set({ step: { fraction, kind: 'loading' } }),
      );
      const afterLoad = watch.sample()?.footprint;
      const rows = await transcribeAll(parakeet, uris);
      const { leastAvailable, peak } = watch.stop();
      const times = rows.map((row) => row.ms);
      set({
        report: {
          ...(cut === undefined ? {} : { cut }),
          loadMs,
          memory: {
            afterAssistant,
            afterLoad,
            before,
            leastAvailable,
            peak,
            physical: deps.memory()?.physical,
          },
          options,
          platform: deps.platform,
          rows,
          scores: scoresOf(deps.clips, rows),
          simulator: deps.simulator,
          timing: { medianMs: quantile(times, 0.5), p90Ms: quantile(times, 0.9) },
          when: new Date(deps.now()).toISOString(),
        },
      });
    } catch (error) {
      set({ notice: messageOf(error) });
    } finally {
      watch.stop();
      fetching = undefined;
      await parakeet.release().catch(() => undefined);
      deps.keepAwake(false);
      set({ memory: deps.memory(), step: { kind: 'idle' } });
    }
  };

  return {
    getState: (): SpeechSpikeState => state,
    /** The app left the screen: the run stops after the clip under way, and keeps what it measured. */
    interrupt: (): void => {
      if (state.step.kind !== 'idle') {
        cut = 'The app left the screen.';
        fetching?.abort();
      }
    },
    readMemory: (): void => set({ memory: deps.memory() }),
    run,
    setOptions: (next: Partial<SpeechSpikeOptions>): void => {
      if (state.step.kind === 'idle') {
        set({ options: { ...state.options, ...next } });
      }
    },
    share: async (): Promise<void> => {
      const { report } = state;
      if (report === undefined || deps.files === undefined) {
        return;
      }
      const stamp = report.when.replaceAll(/[-:]/gu, '').slice(0, 15);
      await deps.files.share(
        `speech-spike-${report.options.version}-${stamp}.json`,
        `${JSON.stringify(report, null, 2)}\n`,
      );
    },
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export type SpeechSpikeStore = ReturnType<typeof createSpeechSpikeStore>;
