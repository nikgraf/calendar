import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Heard as Reading,
  type LanguageModel,
  type QuickAddResult,
  readingsFor,
  type RefineResult,
} from '@calendar/ai';
import {
  type Contact,
  type DictationVocabulary,
  dictationVocabulary,
  VOCABULARY_LIMIT,
} from '@calendar/core';
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
import {
  type Device,
  deviceOf,
  deviceText,
  type Hearing,
  helperSpeech,
  languagesFor,
  type Speech,
} from './listening.ts';
import { type PlaceLookup, placeLookup } from './placeLookup.ts';
import { outcomeOf, type PlaceOutcome } from './places.ts';
import { plainTurn } from './plain.ts';
import {
  benchProviders,
  benchToday,
  connectHelper,
  findHelper,
  gitSha,
  recording,
} from './providers.ts';
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
 * The model bench: the cases under `cases/` through the Assistant's tuned
 * path (the app's own code, `@calendar/ai` `tunedTurn`) on real models,
 * side by side, scored by where a person would put the event. Not a gate
 * — it prints a table, writes a report and passes — and never part of
 * `pnpm test` or the e2e suite: it skips itself unless MODEL_BENCH=1, and
 * runs against whatever is on this machine. The report keeps the raw
 * answers.
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
 * `tuned` (the default: the app's prompt for a model trained on it,
 * `tuned.ts`) and `plain` (one prompt that states the conventions and
 * the schema, for a general model: `plain.ts`, the arm the training data's
 * teacher answers). MODEL_BENCH_RESCORE names earlier reports (files or
 * a folder of them) to score again by the checks as they are now, without
 * asking any model (`rescore.ts`).
 * MODEL_BENCH_CASES picks cases by id part or tag ("flow,de");
 * MODEL_BENCH_STT=off parses every recording's transcript instead of
 * hearing it; MODEL_BENCH_COMPARE names an earlier report to diff
 * against; MODEL_BENCH_OUT the report folder (output/bench).
 *
 * A recording is heard as the app hears a phrase (`listening.ts`), on the
 * device the run names: MODEL_BENCH_LANGUAGE the language it listens in
 * (each case's own without it), MODEL_BENCH_SECOND_LANGUAGE the second
 * one (a locale, `auto` or `off`; the bench's other language without
 * it), MODEL_BENCH_PARAKEET the folder of Parakeet's files when it reads
 * the phrase too, with the address book's names to listen for;
 * MODEL_BENCH_PLACE_NAMES=cases adds the places the cases mean to them,
 * as the calendar of someone who has been to each would.
 * MODEL_BENCH_PLACES=mapkit asks the app's place lookup for each place a
 * case says is meant (`expect.place`), with the hearing's other readings
 * of it, as a dictated turn does; without it the location's text decides.
 */

const TIME_ZONE = 'Europe/Vienna';
const BENCH_DIR = import.meta.dirname;
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** The city the bench's user lives in (`TIME_ZONE`'s): where the place lookup's nearby is. */
const NEAR = 'vienna';

interface Words {
  readonly audio?: TurnReport['audio'];
  /** Why the recording could not be heard; the transcript was parsed instead. */
  readonly error?: string | undefined;
  readonly heard?: string | undefined;
  /** The whole reading, whose other readings the place lookup asks; never in the report. */
  readonly reading?: Reading | undefined;
  /** Each recogniser's own words, for the report. */
  readonly readings?: TurnReport['readings'];
  readonly text: string;
  /** What a heard recording says, word for word: the report keeps it beside what was heard. */
  readonly transcript?: string | undefined;
  readonly wordErrorRate?: number | undefined;
}

interface Languages {
  readonly locale: string;
  readonly other: string;
}

/** One hearing per file, languages and names, however many providers run. */
const hearings = new Map<string, Promise<Hearing>>();

const listen = (
  speech: Speech,
  path: string,
  languages: Languages,
  names: DictationVocabulary,
): Promise<Hearing> => {
  const key = JSON.stringify([path, languages.locale, languages.other, names]);
  let waiting = hearings.get(key);
  if (waiting === undefined) {
    waiting = speech.hear(path, languages, [...names.people, ...names.places], names.people);
    waiting.catch(() => hearings.delete(key));
    hearings.set(key, waiting);
  }
  return waiting;
};

/** What each recogniser wrote, as the report keeps it: only the readings there were. */
const readingsOf = ({ heard, parakeet }: Hearing): TurnReport['readings'] => ({
  ...(heard?.apple === undefined ? {} : { apple: heard.apple }),
  ...(heard?.other === undefined ? {} : { other: heard.other }),
  ...(parakeet === undefined ? {} : { parakeet }),
});

/** The words a turn's input gives the parser: its text, or what the app's listening made of its recording. */
const hear = async (
  input: TurnInput,
  {
    languages,
    names,
    speech,
  }: {
    readonly languages: Languages;
    readonly names: DictationVocabulary;
    readonly speech: Speech | undefined;
  },
): Promise<Words> => {
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
  let hearing: Hearing;
  try {
    hearing = await listen(speech, path, languages, names);
  } catch (error) {
    // The recogniser's failure is the recording's; the words as said still measure the parser.
    return {
      audio: 'failed',
      error: error instanceof Error ? error.message : String(error),
      text: input.transcript,
    };
  }
  // Nothing heard is an empty phrase, which the parser refuses.
  const heard = hearing.heard?.text ?? '';
  return {
    audio: 'transcribed',
    heard,
    reading: hearing.heard,
    readings: readingsOf(hearing),
    text: heard,
    transcript: input.transcript,
    wordErrorRate: wordErrorRate(input.transcript, heard),
  };
};

/** One lookup per place text, readings and place meant, however many providers run. */
const lookups = new Map<string, Promise<PlaceOutcome>>();

/**
 * The outcome with what the app's lookup makes of its location, where
 * the turn's expectation says which place is meant and the run asks
 * MapKit: the place as the draft names it and, for a recording, the
 * hearing's other readings of it, as a dictated turn asks (`readingsFor`).
 */
const withPlace = async (
  outcome: Outcome,
  {
    names,
    places,
    reading,
  }: {
    readonly names: ReadonlyArray<string> | undefined;
    readonly places: PlaceLookup | undefined;
    readonly reading: Reading | undefined;
  },
): Promise<Outcome> => {
  if (places === undefined || names === undefined || outcome.kind !== 'draft') {
    return outcome;
  }
  const { item } = outcome.draft;
  const location = item.kind === 'event' ? (item.prefill.location ?? '').trim() : '';
  if (location === '') {
    return outcome;
  }
  const alternatives = reading === undefined ? [] : readingsFor(reading, location);
  const key = JSON.stringify([location, alternatives, names]);
  let waiting = lookups.get(key);
  if (waiting === undefined) {
    waiting = places
      .ask(NEAR, { ...(alternatives.length > 0 ? { alternatives } : {}), location })
      .then(({ candidates, failures }) => {
        const found = outcomeOf(candidates, names, failures);
        if (found.errors.length > 0) {
          // A lookup MapKit let down is asked again the next time, not kept as a miss.
          lookups.delete(key);
        }
        return found;
      });
    waiting.catch(() => lookups.delete(key));
    lookups.set(key, waiting);
  }
  return { draft: { ...outcome.draft, place: await waiting }, kind: 'draft' };
};

const PIPELINES = ['tuned', 'plain'] as const;
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
  return tunedTurn(model, { draft, earlier: said, referenceDate: today, text });
};

const runCase = async (
  benchCase: BenchCase,
  {
    book,
    device,
    model,
    pipeline,
    placeNames,
    places,
    speech,
    today,
  }: {
    readonly book: ReadonlyArray<Contact>;
    readonly device: Device;
    readonly model: ReturnType<typeof recording>;
    readonly pipeline: Pipeline;
    readonly placeNames: ReadonlyArray<string>;
    readonly places: PlaceLookup | undefined;
    readonly speech: Speech | undefined;
    readonly today: string;
  },
): Promise<CaseReport> => {
  const languages = languagesFor(device, localeOf(benchCase));
  // The names Parakeet listens for: the address book's people, as the app hands them on (no
  // events here), and the places the run lists (MODEL_BENCH_PLACE_NAMES).
  const names: DictationVocabulary = {
    people: dictationVocabulary([], book).people,
    places: placeNames.slice(0, VOCABULARY_LIMIT),
  };
  const turns: Array<TurnReport> = [];
  // The thread's words so far, as heard: what a later turn leans on.
  const earlier: Array<string> = [];
  let draft: BenchDraft | undefined;
  for (const [index, turn] of benchCase.turns.entries()) {
    const heard = await hear(turn.input, { languages, names, speech });
    if (index > 0 && draft === undefined) {
      // The first phrase made nothing to change.
      const checked = checkWithoutDraft(turn.expect, today);
      const { error, reading: _reading, ...spoken } = heard;
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
    const applied = await applyResult(
      draft,
      await runTurn({ model: model.model, pipeline }, draft, heard.text, today, earlier),
      book,
    );
    // The model's time: the place lookup may wait a minute for MapKit's limit.
    const ms = Date.now() - started;
    const outcome: Outcome = await withPlace(applied, {
      names: turn.expect.place,
      places,
      reading: heard.reading,
    });
    const result = check(turn.expect, outcome, draft, today);
    // The turn failed on words that are not the transcript's to the letter (a word misheard, or
    // only the recogniser's punctuation and spelling): would the words as written have passed?
    let said: TurnReport['said'];
    if (
      heard.audio === 'transcribed' &&
      result.failed.length > 0 &&
      'transcript' in turn.input &&
      heard.text !== turn.input.transcript
    ) {
      // Its calls are not the turn's: a list of their own, not kept.
      model.begin();
      // Typed, the words have no other readings: the place is asked as written.
      const transcriptOutcome = await withPlace(
        await applyResult(
          draft,
          await runTurn(
            { model: model.model, pipeline },
            draft,
            turn.input.transcript,
            today,
            earlier,
          ),
          book,
        ),
        { names: turn.expect.place, places, reading: undefined },
      );
      const transcriptCheck = check(turn.expect, transcriptOutcome, draft, today);
      said = {
        notes: transcriptCheck.notes,
        ok: transcriptCheck.failed.length === 0,
        outcome: transcriptOutcome,
      };
    }
    const { error, reading: _reading, ...spoken } = heard;
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
    blind: benchCase.blind,
    id: benchCase.id,
    ok: turns.every((turn) => turn.failed.length === 0),
    tags: benchCase.tags,
    turns,
  };
};

/** What runs around the model, per MODEL_BENCH_PIPELINE: the tuned path unless it names others. */
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
  return known.length === 0 ? ['tuned'] : known;
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
    const today = benchToday(TIME_ZONE);
    const sha = gitSha(ROOT);
    const lines: Array<string> = [`\nMODEL BENCH — today ${today}, ${TIME_ZONE}, ${sha}\n`];
    const log = (line: string) => {
      lines.push(line);
    };
    // Blind cases are counted, never named, unless an expectation is being fixed.
    const table = { showBlind: process.env['MODEL_BENCH_BLIND'] === 'show' };
    const cases = filterCases(
      loadCases(join(BENCH_DIR, 'cases')),
      process.env['MODEL_BENCH_CASES'],
      table,
    );
    const books = loadContacts(join(BENCH_DIR, 'contacts.json'));
    const helperBinary = findHelper();
    const helper = helperBinary === undefined ? undefined : connectHelper(helperBinary);
    const device = deviceOf(process.env);
    const speech =
      helper !== undefined && process.env['MODEL_BENCH_STT'] !== 'off'
        ? helperSpeech(helper, device)
        : undefined;
    const places =
      helper !== undefined && process.env['MODEL_BENCH_PLACES'] === 'mapkit'
        ? placeLookup(helper)
        : undefined;
    // What the recordings were heard with and looked up in is part of a result, where there are any.
    const recorded = cases.some((benchCase) =>
      benchCase.turns.some(
        (turn) => 'audio' in turn.input && existsSync(join(BENCH_DIR, 'audio', turn.input.audio)),
      ),
    );
    // The places the cases mean, listed as Parakeet's names: a calendar that has been to each.
    const placeNames =
      process.env['MODEL_BENCH_PLACE_NAMES'] === 'cases'
        ? [
            ...new Set(
              cases.flatMap((benchCase) =>
                benchCase.turns.flatMap((turn) => turn.expect.place?.slice(0, 1) ?? []),
              ),
            ),
          ]
        : [];
    const around = [
      recorded && speech !== undefined ? `heard with: ${deviceText(device)}` : undefined,
      recorded && speech !== undefined && placeNames.length > 0
        ? `${String(Math.min(placeNames.length, VOCABULARY_LIMIT))} places listed`
        : undefined,
      places === undefined ? undefined : 'places asked of MapKit',
    ].filter((part) => part !== undefined);
    if (around.length > 0) {
      log(`   ${around.join('; ')}\n`);
    }
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
          log(formatReport(after, table));
          log(compareReports(before, after, table));
          log(`   report: ${writeReport(outDir, after)}\n`);
        }
        return;
      }
      // A folder without Parakeet's files stops the run: its phrases would be Apple's words under Parakeet's name.
      await speech?.ready();
      const available = await benchProviders(helper, log);
      if (available.length === 0) {
        log(
          'No model to bench: build the desktop helper (pnpm --filter @calendar/desktop build:helper), point MODEL_BENCH_HELPER at one, or name a served model (MODEL_BENCH_OLLAMA, MODEL_BENCH_OPENAI).',
        );
      }
      const arms = available.flatMap((provider) =>
        pipelines().map((pipeline) => ({
          around: provider.around,
          model: provider.model,
          name: `${provider.name}+${pipeline}`,
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
              device,
              model,
              pipeline: provider.pipeline,
              placeNames,
              places,
              speech,
              today,
            }),
          );
        }
        const report: BenchReport = {
          cases: reports,
          provider: provider.name,
          score: scoreOf(reports),
          settings:
            [provider.settings, ...around].filter((part) => part !== undefined).join('; ') ||
            undefined,
          sha,
          timeZone: TIME_ZONE,
          today,
          when: new Date().toISOString(),
        };
        log(formatReport(report, table));
        // One model beside its own earlier run, or the run's only model beside another (v2, then v3).
        if (earlier !== undefined && (earlier.provider === provider.name || arms.length === 1)) {
          log(compareReports(earlier, report, table));
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
