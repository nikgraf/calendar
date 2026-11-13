import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { loadCases, loadContacts } from '../cases.ts';
import { applyResult, type BenchDraft, fold } from '../check.ts';
import { plainState, plainTurn } from '../plain.ts';
import {
  openAiExtra,
  openAiJsonMode,
  openAiModel,
  type OpenAiUsage,
  recording,
} from '../providers.ts';
import { shortDraft, tunedExample } from '../tuned.ts';
import { asSaid, buildSaidPrompt, SAID_SCHEMA, type SaidForm, saidOf } from './asSaid.ts';
import {
  bookOf,
  type Brief,
  BRIEFS,
  buildGeneratorPrompt,
  buildNamesPrompt,
  GENERATOR_SCHEMA,
  type Names,
  NAMES_SCHEMA,
  namesOf,
  nearBench,
  referenceDateOf,
  repeatsBriefExample,
  threadsOf,
} from './phrases.ts';

/**
 * The training data for the tuned arm, in five steps that each leave a
 * file behind and pick up where a run before them stopped:
 *
 *   names     the generator writes the people and places the phrases
 *             may name                                    → names.json
 *   generate  it writes practice threads, one batch per brief
 *             (`phrases.ts`)                              → threads.jsonl
 *   label     a teacher answers every turn through the plain arm, the
 *             draft carried from turn to turn as the bench carries it
 *                                                         → labelled.jsonl
 *   said      the teacher is asked how each turn gave its day and which
 *             weekdays a repeat rules out (`asSaid.ts`)   → said.jsonl
 *   export    each labelled turn as a chat a model is trained on, its
 *             day and repeat written as said where the two answers
 *             agree, the threads split into training and validation
 *                                             → train.jsonl, valid.jsonl
 *
 *   TRAIN_DATA=names,generate,label,said,export E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/train/dataset.e2e.ts
 *
 * Both models are served behind an OpenAI-compatible endpoint and only
 * models whose licence and whose API's terms allow training other models
 * on their outputs may be named: DeepSeek V4 over DeepSeek's own API (MIT
 * weights; its Open Platform terms name distillation as a permitted use).
 * Never Claude: Anthropic's Usage Policy forbids using its outputs to
 * train an AI model, and a Claude model is refused here. TRAIN_GENERATOR
 * (deepseek-v4-pro) writes, TRAIN_TEACHER (deepseek-flash) labels;
 * TRAIN_GENERATOR_EXTRA and TRAIN_TEACHER_EXTRA join their requests (the
 * thinking switch), TRAIN_OPENAI_URL (https://api.deepseek.com),
 * TRAIN_OPENAI_KEY and TRAIN_OPENAI_JSON (object: JSON mode, the schema
 * in the prompt) say how to reach them. Every answer's token counts land
 * in usage.jsonl. TRAIN_DIR is where the files go
 * (output/bench/finetune/data), TRAIN_PER_BRIEF how many threads a batch
 * asks for (30), TRAIN_LIMIT how many briefs or threads a step takes
 * (all), TRAIN_CONCURRENCY how many requests run at once (8). Never part
 * of `pnpm test`: it skips itself unless TRAIN_DATA is set.
 */

const TIME_ZONE = 'Europe/Vienna';

type Role = 'generator' | 'teacher';

const DEFAULT_MODEL: Readonly<Record<Role, string>> = {
  generator: 'deepseek-v4-pro',
  teacher: 'deepseek-flash',
};

/**
 * The model a role is played by, its token counts added up as it goes.
 * A Claude model is refused: its outputs may not be trained on.
 */
const trainingModel = (role: Role, dir: string, step: string) => {
  const name = (
    process.env[role === 'generator' ? 'TRAIN_GENERATOR' : 'TRAIN_TEACHER'] ?? DEFAULT_MODEL[role]
  ).trim();
  if (/claude|anthropic/iu.test(name)) {
    throw new Error(
      `${name}: Anthropic's Usage Policy forbids training a model on Claude's outputs — name an open model whose terms allow it`,
    );
  }
  const total = { calls: 0, completion: 0, hit: 0, miss: 0, prompt: 0 };
  const onUsage = (usage: OpenAiUsage) => {
    total.calls += 1;
    total.prompt += usage.prompt_tokens ?? 0;
    total.completion += usage.completion_tokens ?? 0;
    total.hit += usage.prompt_cache_hit_tokens ?? 0;
    total.miss += usage.prompt_cache_miss_tokens ?? 0;
  };
  const model = openAiModel(
    process.env['TRAIN_OPENAI_URL'] ?? 'https://api.deepseek.com',
    name,
    process.env['TRAIN_OPENAI_KEY'],
    openAiExtra(
      process.env[role === 'generator' ? 'TRAIN_GENERATOR_EXTRA' : 'TRAIN_TEACHER_EXTRA'],
    ),
    { jsonMode: openAiJsonMode(process.env['TRAIN_OPENAI_JSON'] ?? 'object'), onUsage },
  );
  return {
    model,
    name,
    /** Writes the step's token counts beside the data, for the cost of a run. */
    settle: () => {
      appendFileSync(
        join(dir, 'usage.jsonl'),
        `${JSON.stringify({ model: name, role, step, when: new Date().toISOString(), ...total })}\n`,
      );
      return total;
    },
  };
};

const usageLine = (usage: {
  readonly calls: number;
  readonly completion: number;
  readonly hit: number;
  readonly miss: number;
}): string =>
  `${String(usage.calls)} answers, ${String(usage.miss)} prompt tokens read fresh, ${String(usage.hit)} from cache, ${String(usage.completion)} written`;

const readNames = (dir: string): Names => {
  const path = join(dir, 'names.json');
  if (!existsSync(path)) {
    throw new Error(`${path} is missing: run the names step first`);
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Names;
};

const BENCH_CONTACTS = fileURLToPath(new URL('../contacts.json', import.meta.url));

const names = async (dir: string, log: (line: string) => void): Promise<void> => {
  const path = join(dir, 'names.json');
  if (existsSync(path)) {
    log(`names: ${path} is there already`);
    return;
  }
  const generator = trainingModel('generator', dir, 'names');
  const answer = await generator.model.generateJson({
    jsonSchema: NAMES_SCHEMA,
    prompt: buildNamesPrompt(60, 40),
  });
  const benchBook = Object.values(loadContacts(BENCH_CONTACTS)).flat();
  const written = namesOf(answer, benchBook);
  writeFileSync(path, `${JSON.stringify(written, null, 2)}\n`);
  log(
    `names: ${String(written.people.length)} people and ${String(written.places.length)} places from ${generator.name}; ${usageLine(generator.settle())}`,
  );
};
const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));
const CASES_DIR = fileURLToPath(new URL('../cases', import.meta.url));

interface GeneratedThread extends Brief {
  readonly briefIndex: number;
  readonly turns: ReadonlyArray<string>;
}

interface LabelledTurn {
  /** What the teacher wrote, as it came. */
  readonly answer?: unknown;
  /** The draft the turn was said to; none for a first phrase. */
  readonly draft?: BenchDraft | undefined;
  readonly earlier: ReadonlyArray<string>;
  readonly error?: string | undefined;
  /** What the plain arm made of the answer. */
  readonly kind: string;
  readonly text: string;
}

interface LabelledThread extends Brief {
  readonly id: number;
  readonly referenceDate: string;
  readonly turns: ReadonlyArray<LabelledTurn>;
}

const readLines = <Line>(path: string): Array<Line> =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Line)
    : [];

const numberOf = (name: string, fallback: number): number => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** `size` at a time, in order of starting; one failure does not stop the rest. */
const pooled = async <Item>(
  items: ReadonlyArray<Item>,
  size: number,
  work: (item: Item) => Promise<void>,
): Promise<void> => {
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const item = items[next];
      next += 1;
      if (item !== undefined) {
        await work(item);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
};

const generate = async (dir: string, log: (line: string) => void): Promise<void> => {
  const path = join(dir, 'threads.jsonl');
  const done = new Set(readLines<GeneratedThread>(path).map((thread) => thread.briefIndex));
  const writer = trainingModel('generator', dir, 'generate');
  const generator = writer.model;
  const model = writer.name;
  const listed = readNames(dir);
  const perBrief = numberOf('TRAIN_PER_BRIEF', 30);
  const todo = BRIEFS.map((brief, briefIndex) => ({ brief, briefIndex }))
    .filter(({ briefIndex }) => !done.has(briefIndex))
    .slice(0, numberOf('TRAIN_LIMIT', BRIEFS.length));
  let written = 0;
  let failed = 0;
  await pooled(todo, numberOf('TRAIN_CONCURRENCY', 8), async ({ brief, briefIndex }) => {
    let answer: unknown;
    try {
      answer = await generator.generateJson({
        jsonSchema: GENERATOR_SCHEMA,
        prompt: buildGeneratorPrompt(brief, briefIndex, perBrief, listed),
      });
    } catch (error) {
      failed += 1;
      log(
        `generate: brief ${String(briefIndex)} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return;
    }
    const threads = threadsOf(answer);
    appendFileSync(
      path,
      threads
        .map(
          (turns) =>
            `${JSON.stringify({ ...brief, briefIndex, turns } satisfies GeneratedThread)}\n`,
        )
        .join(''),
    );
    written += threads.length;
  });
  log(
    `generate: ${String(todo.length - failed)} of ${String(todo.length)} briefs with ${model}, ${String(written)} threads written, ${String(done.size)} briefs were there already; ${usageLine(writer.settle())}`,
  );
};

/**
 * The threads worth labelling: no phrase twice, none that reads like a
 * case of the bench, none that repeats an example the briefs quote.
 */
const threadsToLabel = (
  generated: ReadonlyArray<GeneratedThread>,
  benchPhrases: ReadonlyArray<string>,
  log: (line: string) => void,
): ReadonlyArray<GeneratedThread & { readonly id: number }> => {
  const seen = new Set<string>();
  let twice = 0;
  let near = 0;
  let echo = 0;
  let cut = 0;
  const kept = generated.flatMap((thread, id) => {
    const [first, ...rest] = thread.turns;
    if (first === undefined) {
      return [];
    }
    if (seen.has(fold(first))) {
      twice += 1;
      return [];
    }
    seen.add(fold(first));
    if (nearBench(first, benchPhrases)) {
      near += 1;
      return [];
    }
    if (repeatsBriefExample(first)) {
      echo += 1;
      return [];
    }
    // A follow-up that reads like one of the bench's, or repeats a brief's example, ends the thread before it.
    const stop = rest.findIndex(
      (turn) => nearBench(turn, benchPhrases) || repeatsBriefExample(turn),
    );
    if (stop !== -1) {
      cut += 1;
    }
    return [{ ...thread, id, turns: [first, ...(stop === -1 ? rest : rest.slice(0, stop))] }];
  });
  log(
    `label: ${String(kept.length)} of ${String(generated.length)} threads kept (${String(twice)} said twice, ${String(near)} read like a bench case, ${String(echo)} repeat a brief's example, ${String(cut)} cut before a follow-up that does either)`,
  );
  return kept;
};

const label = async (dir: string, log: (line: string) => void): Promise<void> => {
  const path = join(dir, 'labelled.jsonl');
  const benchPhrases = loadCases(CASES_DIR).flatMap((benchCase) =>
    benchCase.turns.map((turn) => ('text' in turn.input ? turn.input.text : turn.input.transcript)),
  );
  const done = new Set(readLines<LabelledThread>(path).map((thread) => thread.id));
  const labeller = trainingModel('teacher', dir, 'label');
  const teacher = labeller.model;
  const model = labeller.name;
  const book = bookOf(readNames(dir).people);
  const todo = threadsToLabel(
    readLines<GeneratedThread>(join(dir, 'threads.jsonl')),
    benchPhrases,
    log,
  )
    .filter((thread) => !done.has(thread.id))
    .slice(0, numberOf('TRAIN_LIMIT', Number.MAX_SAFE_INTEGER));
  let failed = 0;
  await pooled(todo, numberOf('TRAIN_CONCURRENCY', 8), async (thread) => {
    // One recorder a thread: threads run side by side.
    const recorded = recording(teacher);
    const referenceDate = referenceDateOf(thread.id);
    const turns: Array<LabelledTurn> = [];
    const earlier: Array<string> = [];
    let draft: BenchDraft | undefined;
    for (const text of thread.turns) {
      const calls = recorded.begin();
      const result = await plainTurn(recorded.model, {
        draft,
        earlier: [...earlier],
        referenceDate,
        text,
        timeZone: TIME_ZONE,
      });
      const call = calls[0];
      turns.push({
        answer: call?.answer,
        draft,
        earlier: [...earlier],
        error: call?.error,
        kind: result.kind,
        text,
      });
      if (call === undefined || call.error !== undefined) {
        failed += 1;
        break;
      }
      const outcome = await applyResult(draft, result, book);
      if (outcome.kind === 'draft') {
        draft = outcome.draft;
        earlier.push(text);
      } else if (draft === undefined) {
        // Nothing was made: a follow-up has nothing to change.
        break;
      }
    }
    const { briefIndex: _brief, id, turns: _said, ...brief } = thread;
    appendFileSync(
      path,
      `${JSON.stringify({ ...brief, id, referenceDate, turns } satisfies LabelledThread)}\n`,
    );
  });
  log(
    `label: ${String(todo.length)} threads with ${model}, ${String(failed)} ended on a failed call, ${String(done.size)} were there already; ${usageLine(labeller.settle())}`,
  );
};

interface SaidThread {
  readonly id: number;
  /** The teacher's second answer to each turn as it came; null for a turn that was not asked. */
  readonly turns: ReadonlyArray<unknown>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const repeatText = (repeat: unknown): string =>
  JSON.stringify(shortDraft({ repeat: isRecord(repeat) ? repeat : undefined }));

/**
 * A turn whose words may have given a day or ruled a weekday out: a
 * first phrase with either, or a later turn that changed either. A turn
 * that left both as the draft had them is not asked.
 */
const mayHaveSaid = (turn: LabelledTurn): boolean => {
  const { answer } = turn;
  if (turn.error !== undefined || !isRecord(answer)) {
    return false;
  }
  const state = turn.draft === undefined ? undefined : plainState(turn.draft);
  return state === undefined
    ? typeof answer['date'] === 'string' || isRecord(answer['repeat'])
    : answer['date'] !== state.date || repeatText(answer['repeat']) !== repeatText(state.repeat);
};

const said = async (dir: string, log: (line: string) => void): Promise<void> => {
  const path = join(dir, 'said.jsonl');
  const done = new Set(readLines<SaidThread>(path).map((thread) => thread.id));
  const asker = trainingModel('teacher', dir, 'said');
  const teacher = asker.model;
  const model = asker.name;
  const todo = readLines<LabelledThread>(join(dir, 'labelled.jsonl'))
    .filter((thread) => !done.has(thread.id))
    .slice(0, numberOf('TRAIN_LIMIT', Number.MAX_SAFE_INTEGER));
  let asked = 0;
  let failed = 0;
  await pooled(todo, numberOf('TRAIN_CONCURRENCY', 8), async (thread) => {
    const turns: Array<unknown> = [];
    for (const turn of thread.turns) {
      if (!mayHaveSaid(turn)) {
        turns.push(null);
        continue;
      }
      try {
        turns.push(
          await teacher.generateJson({
            jsonSchema: SAID_SCHEMA,
            prompt: buildSaidPrompt({ earlier: turn.earlier, text: turn.text }),
          }),
        );
        asked += 1;
      } catch {
        // Not written: the thread is asked again by the next run.
        failed += 1;
        return;
      }
    }
    appendFileSync(path, `${JSON.stringify({ id: thread.id, turns } satisfies SaidThread)}\n`);
  });
  log(
    `said: ${String(todo.length - failed)} of ${String(todo.length)} threads with ${model}, ${String(asked)} turns asked, ${String(done.size)} threads were there already; ${usageLine(asker.settle())}`,
  );
};

/** One thread in twenty is held back to watch the training by. */
const isValidation = (id: number): boolean => id % 20 === 7;

const exportData = (dir: string, log: (line: string) => void): void => {
  const threads = readLines<LabelledThread>(join(dir, 'labelled.jsonl'));
  const second = new Map(
    readLines<SaidThread>(join(dir, 'said.jsonl')).map((thread) => [thread.id, thread.turns]),
  );
  const train: Array<string> = [];
  const valid: Array<string> = [];
  const count = { first: 0, later: 0, nothing: 0, skipped: 0 };
  // How many answers are written as said, and how many a second answer did not fit.
  const asSaidCount: Record<SaidForm | 'unfit', number> = {
    day: 0,
    except: 0,
    monthDay: 0,
    offset: 0,
    unfit: 0,
  };
  const byLanguage: Record<string, number> = {};
  for (const thread of threads) {
    for (const [index, turn] of thread.turns.entries()) {
      const what = saidOf(second.get(thread.id)?.[index]);
      const written = isRecord(turn.answer)
        ? asSaid(turn.answer, what, {
            draftDate: turn.draft === undefined ? undefined : plainState(turn.draft)?.date,
            referenceDate: thread.referenceDate,
          })
        : undefined;
      const example =
        turn.error === undefined
          ? tunedExample(
              {
                draft: turn.draft,
                earlier: turn.earlier,
                referenceDate: thread.referenceDate,
                text: turn.text,
              },
              written?.answer ?? turn.answer,
            )
          : undefined;
      if (example === undefined) {
        count.skipped += 1;
        continue;
      }
      (isValidation(thread.id) ? valid : train).push(JSON.stringify(example));
      for (const form of written?.forms ?? []) {
        asSaidCount[form] += 1;
      }
      const dayForms = (written?.forms ?? []).filter((form) => form !== 'except').length;
      asSaidCount.unfit += what !== undefined && what.day.how !== 'other' && dayForms === 0 ? 1 : 0;
      count[index === 0 ? 'first' : 'later'] += 1;
      count.nothing += example.messages[1].content === '{"nothingToSchedule":true}' ? 1 : 0;
      byLanguage[thread.language] = (byLanguage[thread.language] ?? 0) + 1;
    }
  }
  writeFileSync(join(dir, 'train.jsonl'), `${train.join('\n')}\n`);
  writeFileSync(join(dir, 'valid.jsonl'), `${valid.join('\n')}\n`);
  const stats = {
    asSaid: asSaidCount,
    byLanguage,
    ...count,
    threads: threads.length,
    train: train.length,
    valid: valid.length,
  };
  writeFileSync(join(dir, 'stats.json'), `${JSON.stringify(stats, null, 2)}\n`);
  log(`export: ${JSON.stringify(stats)}`);
};

describe.skipIf(!process.env['TRAIN_DATA'])('training data for the tuned arm', () => {
  it('runs the steps TRAIN_DATA names', { timeout: 240 * 60_000 }, async () => {
    const steps = (process.env['TRAIN_DATA'] ?? '').split(',').map((step) => step.trim());
    const unknown = steps.filter(
      (step) => !['names', 'generate', 'label', 'said', 'export'].includes(step),
    );
    expect(unknown).toEqual([]);
    const dir = process.env['TRAIN_DIR'] ?? join(ROOT, 'output', 'bench', 'finetune', 'data');
    mkdirSync(dir, { recursive: true });
    const lines: Array<string> = [`\nTRAINING DATA — ${dir}`];
    const log = (line: string) => {
      lines.push(line);
    };
    try {
      if (steps.includes('names')) {
        await names(dir, log);
      }
      if (steps.includes('generate')) {
        await generate(dir, log);
      }
      if (steps.includes('label')) {
        await label(dir, log);
      }
      if (steps.includes('said')) {
        await said(dir, log);
      }
      if (steps.includes('export')) {
        exportData(dir, log);
      }
    } finally {
      process.stdout.write(`${lines.join('\n')}\n`);
    }
  });
});
