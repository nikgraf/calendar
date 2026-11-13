import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type LanguageModel,
  parseQuickAdd,
  parseRefine,
  type QuickAddResult,
  type RefineResult,
} from '@calendar/ai';
import { convertQuickAddItem } from '@calendar/app-state/quickAddItem';
import { type Contact, Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  type BenchCase,
  filterCases,
  loadCases,
  loadContacts,
  localeOf,
  type TurnInput,
} from './cases.ts';
import {
  applyResult,
  type BenchDraft,
  check,
  checkWithoutDraft,
  type Outcome,
  wordErrorRate,
} from './check.ts';
import { plainTurn } from './plain.ts';
import {
  connectHelper,
  findHelper,
  type HelperClient,
  helperModel,
  helperSpeech,
  helperStatus,
  ollamaModel,
  openAiExtra,
  openAiJsonMode,
  openAiModel,
  recording,
  requiringEveryField,
  type Speech,
} from './providers.ts';
import { rawTurn } from './raw.ts';
import {
  type BenchReport,
  type CaseReport,
  compareReports,
  formatReport,
  scoreOf,
  type TurnReport,
  writeReport,
} from './report.ts';
import { rescore } from './rescore.ts';
import { tunedTurn } from './tuned.ts';

/**
 * The model bench: the cases under `cases/` through the quick-add and
 * refine pipelines on real models, side by side, scored by where a person
 * would put the event. Not a gate — it prints a table, writes a report
 * and passes — and never part of `pnpm test` or the e2e suite: it skips
 * itself unless MODEL_BENCH=1, and runs against whatever is on this
 * machine. On the `app` arm the grounding runs on every answer, as in
 * the app, so its table measures the whole pipeline; the report keeps
 * the raw answers for telling the model's errors from the grounding's.
 *
 *   MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
 *
 * Apple: the desktop helper binary (MODEL_BENCH_HELPER, or the package's
 * own build; MODEL_BENCH_APPLE=0 leaves it out, MODEL_BENCH_APPLE_REQUIRED=1
 * adds it a second time, asked for every field). Ollama: MODEL_BENCH_OLLAMA
 * names the model (several, comma-separated), MODEL_BENCH_OLLAMA_URL the
 * server. An OpenAI-compatible endpoint: MODEL_BENCH_OPENAI (models,
 * comma-separated), MODEL_BENCH_OPENAI_URL (base, up to `/v1`),
 * MODEL_BENCH_OPENAI_KEY, MODEL_BENCH_OPENAI_EXTRA (JSON joined to the
 * request body), MODEL_BENCH_OPENAI_JSON=object for a server with JSON mode
 * only (the schema then goes into the prompt: DeepSeek's API).
 * MODEL_BENCH_PIPELINE lists what runs around the model, comma-separated:
 * `app` (the default: the app's pipeline with its grounding), `raw` (the
 * app's prompts, the answer never held against the words: `raw.ts`),
 * `plain` (one prompt that states the conventions, no code that reads the
 * words: `plain.ts`) and `tuned` (the plain arm without the conventions,
 * for a model trained on its answers: `tuned.ts`). MODEL_BENCH_RESCORE names earlier reports (files or
 * a folder of them) to score again by the checks as they are now, without
 * asking any model (`rescore.ts`).
 * MODEL_BENCH_CASES picks cases by id part or tag ("flow,de");
 * MODEL_BENCH_STT=off parses every recording's transcript instead of
 * transcribing; MODEL_BENCH_COMPARE names an earlier report to diff
 * against; MODEL_BENCH_OUT the report folder (output/bench).
 */

const TIME_ZONE = 'Europe/Vienna';
const BENCH_DIR = import.meta.dirname;
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

interface Heard {
  readonly audio?: TurnReport['audio'];
  /** Why the recording could not be transcribed; the transcript was parsed instead. */
  readonly error?: string | undefined;
  readonly heard?: string | undefined;
  readonly text: string;
  readonly wordErrorRate?: number | undefined;
}

/** One transcription per file and locale, however many providers run. */
const transcriptions = new Map<string, Promise<string>>();

const transcribe = (speech: Speech, path: string, locale: string): Promise<string> => {
  const key = `${locale}:${path}`;
  let waiting = transcriptions.get(key);
  if (waiting === undefined) {
    waiting = speech
      .prepare(locale)
      .then(() => speech.transcribe(readFileSync(path), locale))
      .then((heard) => heard ?? '');
    waiting.catch(() => transcriptions.delete(key));
    transcriptions.set(key, waiting);
  }
  return waiting;
};

/** The words a turn's input gives the parser: its text, or what the recogniser made of its recording. */
const hear = async (
  input: TurnInput,
  { locale, speech }: { readonly locale: string; readonly speech: Speech | undefined },
): Promise<Heard> => {
  if ('text' in input) {
    return { text: input.text };
  }
  const path = join(BENCH_DIR, 'audio', input.audio);
  if (!existsSync(path)) {
    return { audio: 'missing', text: input.transcript };
  }
  if (speech === undefined) {
    return { audio: 'skipped', text: input.transcript };
  }
  let heard: string;
  try {
    heard = await transcribe(speech, path, locale);
  } catch (error) {
    // The recogniser's failure is the recording's; the words as said still measure the parser.
    return {
      audio: 'failed',
      error: error instanceof Error ? error.message : String(error),
      text: input.transcript,
    };
  }
  return {
    audio: 'transcribed',
    heard,
    text: heard,
    wordErrorRate: wordErrorRate(input.transcript, heard),
  };
};

const PIPELINES = ['app', 'raw', 'plain', 'tuned'] as const;
type Pipeline = (typeof PIPELINES)[number];

/** One turn through the pipeline the thread would use: the first phrase, or a change to the draft. */
const runTurn = async (
  { model, pipeline }: { readonly model: LanguageModel; readonly pipeline: Pipeline },
  draft: BenchDraft | undefined,
  text: string,
  today: string,
  said: ReadonlyArray<string>,
): Promise<QuickAddResult | RefineResult> => {
  if (pipeline === 'plain') {
    return plainTurn(model, {
      draft,
      earlier: said,
      referenceDate: today,
      text,
      timeZone: TIME_ZONE,
    });
  }
  if (pipeline === 'tuned') {
    return tunedTurn(model, { draft, earlier: said, referenceDate: today, text });
  }
  if (pipeline === 'raw') {
    return rawTurn(model, { draft, referenceDate: today, text, timeZone: TIME_ZONE });
  }
  if (draft === undefined) {
    return parseQuickAdd(model, { phrase: text, referenceDate: today, timeZone: TIME_ZONE });
  }
  // A to-do is refined as the event it would be, and read back as a to-do.
  const asEvent = convertQuickAddItem(draft.item, 'event');
  if (asEvent.kind !== 'event') {
    return { kind: 'rejected', reason: 'not an event' };
  }
  return parseRefine(model, {
    draft: asEvent.prefill,
    guests: draft.item.kind === 'event',
    referenceDate: today,
    said,
    timeZone: TIME_ZONE,
    utterance: text,
  });
};

const runCase = async (
  benchCase: BenchCase,
  {
    book,
    model,
    pipeline,
    speech,
    today,
  }: {
    readonly book: ReadonlyArray<Contact>;
    readonly model: ReturnType<typeof recording>;
    readonly pipeline: Pipeline;
    readonly speech: Speech | undefined;
    readonly today: string;
  },
): Promise<CaseReport> => {
  const locale = localeOf(benchCase);
  const turns: Array<TurnReport> = [];
  // The thread's words so far, as heard: what a later turn leans on.
  const earlier: Array<string> = [];
  let draft: BenchDraft | undefined;
  for (const [index, turn] of benchCase.turns.entries()) {
    const heard = await hear(turn.input, { locale, speech });
    if (index > 0 && draft === undefined) {
      // The first phrase made nothing to change.
      const checked = checkWithoutDraft(turn.expect, today);
      const { error, ...spoken } = heard;
      turns.push({
        ...spoken,
        calls: [],
        checked: checked.checked,
        failed: checked.failed,
        input: heard.text,
        notes: [
          'no draft to change',
          ...(error === undefined ? [] : [`recording not read: ${error}`]),
        ],
        outcome: undefined,
      });
      continue;
    }
    const started = Date.now();
    const calls = model.begin();
    const outcome: Outcome = await applyResult(
      draft,
      await runTurn({ model: model.model, pipeline }, draft, heard.text, today, earlier),
      book,
    );
    const ms = Date.now() - started;
    const result = check(turn.expect, outcome, draft, today);
    // The recogniser erred and the turn failed: would the words as said have passed?
    let said: TurnReport['said'];
    if (
      heard.audio === 'transcribed' &&
      heard.wordErrorRate !== undefined &&
      heard.wordErrorRate > 0 &&
      result.failed.length > 0 &&
      'transcript' in turn.input
    ) {
      // Its calls are not the turn's: a list of their own, not kept.
      model.begin();
      const transcriptOutcome = await applyResult(
        draft,
        await runTurn(
          { model: model.model, pipeline },
          draft,
          turn.input.transcript,
          today,
          earlier,
        ),
        book,
      );
      const transcriptCheck = check(turn.expect, transcriptOutcome, draft, today);
      said = {
        notes: transcriptCheck.notes,
        ok: transcriptCheck.failed.length === 0,
        outcome: transcriptOutcome,
      };
    }
    const { error, ...spoken } = heard;
    turns.push({
      ...spoken,
      calls,
      checked: result.checked,
      failed: result.failed,
      input: heard.text,
      ms,
      notes: [...result.notes, ...(error === undefined ? [] : [`recording not read: ${error}`])],
      outcome,
      said,
    });
    if (outcome.kind === 'draft') {
      draft = outcome.draft;
      // A turn that was refused left no words in the thread.
      earlier.push(heard.text);
    }
  }
  return {
    id: benchCase.id,
    ok: turns.every((turn) => turn.failed.length === 0),
    tags: benchCase.tags,
    turns,
  };
};

const gitSha = (): string => {
  try {
    // `-dirty` when the tree is not the commit: a report must not name code that did not make it.
    return execFileSync('git', ['describe', '--always', '--dirty', '--abbrev=8'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
};

interface Provider {
  /** What the provider puts around the recorded model, so the report keeps what was sent and what came. */
  readonly around?: ((model: LanguageModel) => LanguageModel) | undefined;
  readonly model: LanguageModel;
  readonly name: string;
  /** What the run set that the name does not say; the report keeps it. */
  readonly settings?: string | undefined;
}

const providers = async (
  helper: HelperClient | undefined,
  log: (line: string) => void,
): Promise<ReadonlyArray<Provider>> => {
  const list: Array<Provider> = [];
  if (helper !== undefined && process.env['MODEL_BENCH_APPLE'] !== '0') {
    let status: string;
    try {
      status = await helperStatus(helper);
    } catch (error) {
      status = `not answering (${error instanceof Error ? error.message : String(error)})`;
    }
    if (status === 'ready') {
      list.push({ model: helperModel(helper), name: 'apple' });
      if (process.env['MODEL_BENCH_APPLE_REQUIRED'] === '1') {
        list.push({
          around: requiringEveryField,
          model: helperModel(helper),
          name: 'apple-required',
        });
      }
    } else {
      log(`Apple's model is ${status}; left out.`);
    }
  }
  const ollamaUrl = process.env['MODEL_BENCH_OLLAMA_URL'] ?? 'http://localhost:11434';
  for (const name of (process.env['MODEL_BENCH_OLLAMA'] ?? '').split(',').filter(Boolean)) {
    list.push({ model: ollamaModel(ollamaUrl, name.trim()), name: `ollama:${name.trim()}` });
  }
  const openAi = (process.env['MODEL_BENCH_OPENAI'] ?? '').split(',').filter(Boolean);
  if (openAi.length > 0) {
    const openAiUrl = process.env['MODEL_BENCH_OPENAI_URL'] ?? 'http://localhost:1234/v1';
    const extra = openAiExtra(process.env['MODEL_BENCH_OPENAI_EXTRA']);
    const jsonMode = openAiJsonMode(process.env['MODEL_BENCH_OPENAI_JSON']);
    for (const name of openAi) {
      list.push({
        model: openAiModel(openAiUrl, name.trim(), process.env['MODEL_BENCH_OPENAI_KEY'], extra, {
          jsonMode,
        }),
        name: `openai:${name.trim()}`,
        // The endpoint and what joined each request: thinking on and thinking off are two results.
        settings: [
          openAiUrl,
          ...(Object.keys(extra).length === 0 ? [] : [JSON.stringify(extra)]),
          ...(jsonMode === 'object' ? ['json-object'] : []),
        ].join(' '),
      });
    }
  }
  return list;
};

/** What runs around the model, per MODEL_BENCH_PIPELINE: the app's pipeline unless it names others. */
const pipelines = (): ReadonlyArray<Pipeline> => {
  const asked = (process.env['MODEL_BENCH_PIPELINE'] ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  const unknown = asked.filter((name) => !(PIPELINES as ReadonlyArray<string>).includes(name));
  if (unknown.length > 0) {
    // A misspelt arm must not run as another one.
    throw new Error(
      `MODEL_BENCH_PIPELINE names no arm "${unknown.join('", "')}": ${PIPELINES.join(', ')}`,
    );
  }
  const known = PIPELINES.filter((pipeline) => asked.includes(pipeline));
  return known.length === 0 ? ['app'] : known;
};

/** The reports MODEL_BENCH_RESCORE names: files, or every report in a folder. */
const reportsToRescore = (value: string): ReadonlyArray<string> =>
  value
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean)
    .flatMap((path) =>
      statSync(path).isDirectory()
        ? readdirSync(path)
            .filter((name) => name.endsWith('.json'))
            .sort()
            .map((name) => join(path, name))
        : [path],
    );

describe.skipIf(process.env['MODEL_BENCH'] !== '1')('model bench', () => {
  it('runs the cases on each model and writes a report', { timeout: 120 * 60_000 }, async () => {
    const today = Temporal.Now.plainDateISO(TIME_ZONE).toString();
    const sha = gitSha();
    const lines: Array<string> = [`\nMODEL BENCH — today ${today}, ${TIME_ZONE}, ${sha}\n`];
    const log = (line: string) => {
      lines.push(line);
    };
    const cases = filterCases(
      loadCases(join(BENCH_DIR, 'cases')),
      process.env['MODEL_BENCH_CASES'],
    );
    const books = loadContacts(join(BENCH_DIR, 'contacts.json'));
    const helperBinary = findHelper();
    const helper = helperBinary === undefined ? undefined : connectHelper(helperBinary);
    const speech =
      helper !== undefined && process.env['MODEL_BENCH_STT'] !== 'off'
        ? helperSpeech(helper)
        : undefined;
    const compareWith = process.env['MODEL_BENCH_COMPARE'];
    const earlier =
      compareWith === undefined
        ? undefined
        : (JSON.parse(readFileSync(compareWith, 'utf8')) as BenchReport);
    const outDir = process.env['MODEL_BENCH_OUT'] ?? join(ROOT, 'output', 'bench');
    const toRescore = process.env['MODEL_BENCH_RESCORE'];
    try {
      if (toRescore) {
        // Every case, whatever MODEL_BENCH_CASES says: a report is scored whole.
        const all = loadCases(join(BENCH_DIR, 'cases'));
        for (const path of reportsToRescore(toRescore)) {
          const before = JSON.parse(readFileSync(path, 'utf8')) as BenchReport;
          const after = rescore(before, all, { sha, when: new Date().toISOString() });
          log(formatReport(after));
          log(compareReports(before, after));
          log(`   report: ${writeReport(outDir, after)}\n`);
        }
        return;
      }
      const available = await providers(helper, log);
      if (available.length === 0) {
        log(
          'No model to bench: build the desktop helper (pnpm --filter @calendar/desktop build:helper), point MODEL_BENCH_HELPER at one, or name a served model (MODEL_BENCH_OLLAMA, MODEL_BENCH_OPENAI).',
        );
      }
      const arms = available.flatMap((provider) =>
        pipelines().map((pipeline) => ({
          around: provider.around,
          model: provider.model,
          // The app's pipeline keeps the provider's bare name: earlier reports compare with it.
          name: pipeline === 'app' ? provider.name : `${provider.name}+${pipeline}`,
          pipeline,
          settings: provider.settings,
        })),
      );
      for (const provider of arms) {
        const recorded = recording(provider.model);
        const model = {
          begin: recorded.begin,
          model: provider.around === undefined ? recorded.model : provider.around(recorded.model),
        };
        const reports: Array<CaseReport> = [];
        for (const benchCase of cases) {
          const book = books[benchCase.contacts];
          if (book === undefined) {
            throw new Error(
              `${benchCase.id}: no address book "${benchCase.contacts}" in contacts.json`,
            );
          }
          reports.push(
            await runCase(benchCase, {
              book,
              model,
              pipeline: provider.pipeline,
              speech,
              today,
            }),
          );
        }
        const report: BenchReport = {
          cases: reports,
          provider: provider.name,
          score: scoreOf(reports),
          settings: provider.settings,
          sha,
          timeZone: TIME_ZONE,
          today,
          when: new Date().toISOString(),
        };
        log(formatReport(report));
        if (earlier !== undefined && earlier.provider === provider.name) {
          log(compareReports(earlier, report));
        } else if (earlier !== undefined) {
          log(`   (MODEL_BENCH_COMPARE is a ${earlier.provider} report; not compared)`);
        }
        log(`   report: ${writeReport(outDir, report)}\n`);
      }
    } finally {
      helper?.close();
      process.stdout.write(`${lines.join('\n')}\n`);
    }
    expect(cases.length).toBeGreaterThan(0);
  });
});
