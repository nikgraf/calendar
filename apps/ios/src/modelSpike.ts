import { type LanguageModel, PUBLISHED_MODEL, type QuickAddResult, tunedTurn } from '@calendar/ai';
import type { SpikeCase } from './modelSpikeCases.ts';
import type { OpenModelCall } from './openModel.ts';

/**
 * The measurement behind Settings › Advanced › Model Spike: the bench's
 * first phrases through the Assistant's tuned path (`tunedTurn`, the
 * code the app and the bench share) on a model loaded into the app,
 * timed, and written as a report the Mac scores with the bench's checks
 * (`apps/desktop/e2e/bench/phoneReport.ts`).
 * Everything here is pure or takes what it calls, so it runs in a test.
 */

/** The zone the bench runs in: the phone's answers are scored against the same days. */
export const SPIKE_TIME_ZONE = 'Europe/Vienna';

/** A model file the page can fetch. Sizes are the files' own, read from the host on 2026-11-11. */
export interface SpikeModel {
  readonly bytes: number;
  /** The name it is stored under in the app's documents. */
  readonly file: string;
  readonly licence: string;
  readonly name: string;
  /** Who made the file, where that is not the model's maker. */
  readonly quantizedBy: string;
  readonly url: string;
}

/**
 * Models trained on the Mac and served from it to the phone: the value of
 * `EXPO_PUBLIC_SPIKE_TUNED` where Metro starts, a JSON list of
 * `{ "name", "url", "bytes" }` with the address of a GGUF file the phone
 * can reach. A value that is no such
 * list, and an entry that is not whole, give no model.
 */
export const tunedModels = (value: string | undefined): ReadonlyArray<SpikeModel> => {
  let listed: unknown;
  try {
    listed = JSON.parse(value?.trim() || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(listed)) {
    return [];
  }
  return listed.flatMap((entry: unknown): Array<SpikeModel> => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const { bytes, name, url } = entry as Record<string, unknown>;
    if (typeof bytes !== 'number' || typeof name !== 'string' || typeof url !== 'string') {
      return [];
    }
    const file = url.split('/').pop() ?? '';
    if (!file.endsWith('.gguf')) {
      return [];
    }
    return [
      {
        bytes,
        file,
        licence: 'The base model’s licence',
        name,
        quantizedBy: 'this project, on the Mac that serves it',
        url,
      },
    ];
  });
};

/**
 * The Assistant's published model (`@calendar/ai`), fetched into the
 * page's own folder, and the ones the Mac serves
 * (`EXPO_PUBLIC_SPIKE_TUNED`).
 */
export const SPIKE_MODELS: ReadonlyArray<SpikeModel> = [
  {
    bytes: PUBLISHED_MODEL.bytes,
    file: PUBLISHED_MODEL.file,
    licence: 'Apache-2.0',
    name: `Solunivo Assistant ${PUBLISHED_MODEL.version}`,
    quantizedBy: 'this project (nikgraf/calendar-models)',
    url: PUBLISHED_MODEL.url,
  },
  // Metro inlines EXPO_PUBLIC_* at bundle time: unset, the page lists the published model alone.
  ...tunedModels(process.env['EXPO_PUBLIC_SPIKE_TUNED']),
];

/** What a phrase came to: the pipeline's result, or why the run could not ask. */
export type SpikeAnswer = QuickAddResult | { readonly kind: 'failed'; readonly message: string };

export interface SpikeRow {
  readonly calls: ReadonlyArray<OpenModelCall>;
  readonly id: string;
  readonly input: string;
  /** The whole turn, the pipeline's own work included. */
  readonly ms: number;
  readonly result: SpikeAnswer;
}

/**
 * Each case through the tuned path, one after the other, as the thread
 * would send a first phrase. `modelFor` gives the model for one phrase
 * and takes where its calls are counted. A stop is honoured between
 * phrases: the rows so far are the run. A phrase that was cut short from
 * outside (`discarded`) leaves no row: its time and its answer are the
 * interruption's, not the model's.
 */
export const runSpike = async ({
  cases,
  discarded,
  modelFor,
  now,
  onRow,
  referenceDate,
  stopped,
}: {
  readonly cases: ReadonlyArray<SpikeCase>;
  readonly discarded?: () => boolean;
  readonly modelFor: (onCall: (call: OpenModelCall) => void) => LanguageModel;
  readonly now: () => number;
  readonly onRow?: (row: SpikeRow, rows: ReadonlyArray<SpikeRow>) => void;
  /** Today in `SPIKE_TIME_ZONE`, `YYYY-MM-DD`. */
  readonly referenceDate: string;
  readonly stopped?: () => boolean;
}): Promise<ReadonlyArray<SpikeRow>> => {
  const rows: Array<SpikeRow> = [];
  for (const spikeCase of cases) {
    if (stopped?.() === true) {
      break;
    }
    const calls: Array<OpenModelCall> = [];
    const started = now();
    let result: SpikeAnswer;
    try {
      const model = modelFor((call) => calls.push(call));
      result = await tunedTurn(model, {
        draft: undefined,
        earlier: [],
        referenceDate,
        text: spikeCase.text,
      });
    } catch (error) {
      result = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    if (discarded?.() === true) {
      break;
    }
    const row = { calls, id: spikeCase.id, input: spikeCase.text, ms: now() - started, result };
    rows.push(row);
    onRow?.(row, rows);
  }
  return rows;
};

const median = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) {
    return 0;
  }
  // Hermes has no `toSorted`: a copy, sorted.
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

const perSecond = (tokens: number, ms: number): number => (ms > 0 ? (tokens * 1000) / ms : 0);

export interface SpikeSummary {
  /** Tokens written per second, over every call; 0 for a run that counted none. */
  readonly answerTokensPerSecond: number;
  /** The share of all prompt tokens the runtime did not have to read: a prefix kept from the call before. */
  readonly cachedShare: number;
  /** Model calls that gave no answer, with the first one's reason. */
  readonly failedCalls: number;
  readonly firstError: string | undefined;
  readonly medianMs: number;
  /** Phrases that became a draft. */
  readonly parsed: number;
  /** Prompt tokens read per second, over every call. */
  readonly promptTokensPerSecond: number;
  readonly turns: number;
  readonly worstMs: number;
}

export const summarize = (rows: ReadonlyArray<SpikeRow>): SpikeSummary => {
  const calls = rows.flatMap((row) => row.calls);
  const sum = (pick: (call: OpenModelCall) => number): number =>
    calls.reduce((total, call) => total + pick(call), 0);
  const prompt = sum((call) => call.promptTokens);
  const read = sum((call) => call.readTokens);
  const failed = calls.filter((call) => call.error !== undefined);
  return {
    answerTokensPerSecond: perSecond(
      sum((call) => call.answerTokens),
      sum((call) => call.answerMs),
    ),
    cachedShare: prompt > 0 ? Math.max(0, prompt - read) / prompt : 0,
    failedCalls: failed.length,
    firstError: failed[0]?.error,
    medianMs: median(rows.map((row) => row.ms)),
    parsed: rows.filter((row) => row.result.kind === 'parsed' || row.result.kind === 'task').length,
    promptTokensPerSecond: perSecond(
      read,
      sum((call) => call.promptMs),
    ),
    turns: rows.length,
    worstMs: rows.reduce((worst, row) => Math.max(worst, row.ms), 0),
  };
};

/** What a row made, on one line: enough to see a wrong draft without the Mac. */
export const describeAnswer = (result: SpikeAnswer): string => {
  if (result.kind === 'failed') {
    return `failed: ${result.message}`;
  }
  if (result.kind === 'rejected') {
    return `refused: ${result.reason}`;
  }
  if (result.kind === 'task') {
    return ['to-do', result.prefill.title, result.prefill.date, result.prefill.time]
      .filter((part) => part !== undefined && part !== '')
      .join(' · ');
  }
  const { prefill } = result;
  return [
    prefill.title,
    prefill.date,
    prefill.isAllDay ? 'all day' : `${prefill.startTime}–${prefill.endTime}`,
    prefill.location,
    prefill.recurrence === undefined ? undefined : `repeats ${prefill.recurrence.freq}`,
    result.invite === undefined || result.invite.length === 0
      ? undefined
      : `invites ${result.invite.join(', ')}`,
  ]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');
};

/** Bytes of the process, read around the steps of a run (`solunivo-process-memory`). */
export interface SpikeMemory {
  /** What iOS said the app may still take, with the model loaded; 0 where it does not say. */
  readonly availableLoaded: number;
  readonly footprintBefore: number;
  readonly footprintLoaded: number;
  /** The highest footprint seen while the phrases ran, read twice a second and after each phrase. */
  readonly footprintPeak: number;
  readonly physical: number;
}

/**
 * One run, as the file the page shares. `rows` hold the pipeline's results
 * untouched, so the Mac can put them through the bench's checks; `today`
 * and `timeZone` are what the phrases were read against. It names no
 * commit: the page cannot tell which JavaScript it runs.
 */
export interface SpikeReport {
  /** How many phrases the run was asked for; `rows` has fewer when it was stopped. */
  readonly asked: number;
  /** Whether the runtime put the model on the GPU (undefined in reports from before 2026-11-13, Apple's model). */
  readonly gpu: boolean | undefined;
  readonly loadMs: number;
  readonly memory: SpikeMemory | undefined;
  readonly model: SpikeModel;
  /** The model as the runtime describes it. */
  readonly modelDescription: string;
  /** `ios 27.1`. */
  readonly platform: string;
  readonly reasonNoGpu: string;
  readonly rows: ReadonlyArray<SpikeRow>;
  /** A simulator ran it: its timings are the Mac's, through the simulator, and say nothing of a phone. */
  readonly simulator: boolean;
  readonly summary: SpikeSummary;
  readonly timeZone: string;
  readonly today: string;
  /** ISO time the run ended. */
  readonly when: string;
}
