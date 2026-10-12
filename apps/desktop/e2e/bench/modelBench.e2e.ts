import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { foldSearchText, Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { type LanguageModel, parseQuickAdd } from '@calendar/ai';

/**
 * The model bench: the phrases in phrases.json through `parseQuickAdd`
 * on real models, side by side, with how many land where a person would
 * put them. Not a gate — it prints a table and passes — and never part of
 * `pnpm test` or the e2e suite: it skips itself unless MODEL_BENCH=1, and
 * runs against whatever is on this machine.
 *
 *   MODEL_BENCH=1 E2E=1 pnpm exec vp test run apps/desktop/e2e/bench/modelBench.e2e.ts
 *
 * Apple: the desktop helper binary (MODEL_BENCH_HELPER, or the dev build
 * under apps/desktop/helper/.build). Ollama: MODEL_BENCH_OLLAMA names the
 * model (several, comma-separated), MODEL_BENCH_OLLAMA_URL the server
 * (http://localhost:11434). The grounding in `normalizeQuickAdd` runs on
 * every answer, as in the app, so the table measures the whole pipeline,
 * not the raw model.
 */

interface Expectation {
  readonly dayOffset?: number;
  readonly endTime?: string;
  readonly isAllDay?: boolean;
  readonly kind?: 'task';
  readonly location?: string;
  readonly startTime?: string;
  readonly titleIncludes?: string;
  /** ISO weekday the date must fall on. */
  readonly weekday?: number;
}

interface Phrase {
  readonly expect: Expectation;
  readonly phrase: string;
}

const PHRASES = JSON.parse(
  readFileSync(new URL('./phrases.json', import.meta.url), 'utf8'),
) as ReadonlyArray<Phrase>;

const TIME_ZONE = 'Europe/Vienna';

const helperModel = (binary: string): LanguageModel => {
  const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  let id = 0;
  const pending = new Map<number, (value: unknown) => void>();
  let buffer = '';
  child.stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
    let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) {
        continue;
      }
      const message = JSON.parse(line) as { error?: string; id: number; result?: { json: string } };
      const resolve = pending.get(message.id);
      if (resolve) {
        pending.delete(message.id);
        resolve(message.result ? JSON.parse(message.result.json) : { error: message.error });
      }
    }
  });
  return {
    generateJson: ({ jsonSchema, prompt }) =>
      new Promise((resolve) => {
        const mine = ++id;
        pending.set(mine, resolve);
        child.stdin.write(
          `${JSON.stringify({ id: mine, method: 'generateJson', params: { prompt, schema: jsonSchema } })}\n`,
        );
      }),
    status: async () => 'ready',
  };
};

const ollamaModel = (baseUrl: string, model: string): LanguageModel => ({
  generateJson: async ({ jsonSchema, prompt }) => {
    const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/chat`, {
      body: JSON.stringify({
        format: jsonSchema,
        keep_alive: '10m',
        messages: [{ content: prompt, role: 'user' }],
        model,
        options: { num_ctx: 16_384, temperature: 0 },
        stream: false,
      }),
      headers: { 'Content-Type': 'application/json' },
      method: 'POST',
    });
    const body = (await response.json()) as { message?: { content?: string } };
    return JSON.parse(body.message?.content ?? '{}') as unknown;
  },
  status: async () => 'ready',
});

/** Which expectations the answer meets, as "field=ok" or "field=got". */
const check = (
  result: Awaited<ReturnType<typeof parseQuickAdd>>,
  expectation: Expectation,
  today: string,
): ReadonlyArray<string> => {
  const notes: Array<string> = [];
  if (result.kind === 'rejected') {
    return [`rejected: ${result.reason}`];
  }
  const { prefill } = result;
  if (expectation.kind === 'task' && result.kind !== 'task') {
    notes.push('kind=event');
  } else if (expectation.kind === undefined && result.kind === 'task') {
    notes.push('kind=task');
  }
  const date = Temporal.PlainDate.from(prefill.date);
  if (expectation.weekday !== undefined && date.dayOfWeek !== expectation.weekday) {
    notes.push(`weekday=${String(date.dayOfWeek)}`);
  }
  if (
    expectation.dayOffset !== undefined &&
    Temporal.PlainDate.from(today).until(date).days !== expectation.dayOffset
  ) {
    notes.push(`day=${prefill.date}`);
  }
  if (result.kind === 'parsed') {
    const event = result.prefill;
    if (expectation.isAllDay !== undefined && event.isAllDay !== expectation.isAllDay) {
      notes.push(`allDay=${String(event.isAllDay)}`);
    }
    if (expectation.startTime !== undefined && event.startTime !== expectation.startTime) {
      notes.push(`start=${event.startTime}`);
    }
    if (expectation.endTime !== undefined && event.endTime !== expectation.endTime) {
      notes.push(`end=${event.endTime}`);
    }
    if (
      expectation.location !== undefined &&
      !foldSearchText(event.location ?? '').includes(expectation.location)
    ) {
      notes.push(`location=${event.location ?? '-'}`);
    }
  }
  if (
    expectation.titleIncludes !== undefined &&
    !foldSearchText(prefill.title).includes(expectation.titleIncludes)
  ) {
    notes.push(`title=${prefill.title}`);
  }
  return notes;
};

const providers = (): ReadonlyArray<{ readonly model: LanguageModel; readonly name: string }> => {
  const list: Array<{ readonly model: LanguageModel; readonly name: string }> = [];
  const helper =
    process.env['MODEL_BENCH_HELPER'] ??
    new URL('../../helper/.build/arm64-apple-macosx/release/solunivo-model-helper', import.meta.url)
      .pathname;
  if (process.env['MODEL_BENCH_APPLE'] !== '0') {
    try {
      readFileSync(helper);
      list.push({ model: helperModel(helper), name: 'apple' });
    } catch {
      // No helper build here: Apple's model is left out of the table.
    }
  }
  const url = process.env['MODEL_BENCH_OLLAMA_URL'] ?? 'http://localhost:11434';
  for (const name of (process.env['MODEL_BENCH_OLLAMA'] ?? '').split(',').filter(Boolean)) {
    list.push({ model: ollamaModel(url, name.trim()), name: `ollama:${name.trim()}` });
  }
  return list;
};

describe.skipIf(process.env['MODEL_BENCH'] !== '1')('model bench', () => {
  it('prints how each model does on the phrases', { timeout: 30 * 60_000 }, async () => {
    const today = Temporal.Now.plainDateISO(TIME_ZONE).toString();
    const lines: Array<string> = [`\nMODEL BENCH — today ${today}, ${TIME_ZONE}\n`];
    const available = providers();
    if (available.length === 0) {
      lines.push(
        'No model to bench: build the desktop helper (or point MODEL_BENCH_HELPER at one) and/or name Ollama models in MODEL_BENCH_OLLAMA.',
      );
    }
    for (const provider of available) {
      let passed = 0;
      lines.push(`== ${provider.name}`);
      for (const { expect: expectation, phrase } of PHRASES) {
        const started = Date.now();
        const result = await parseQuickAdd(provider.model, {
          phrase,
          referenceDate: today,
          timeZone: TIME_ZONE,
        });
        const notes = check(result, expectation, today);
        passed += notes.length === 0 ? 1 : 0;
        lines.push(
          `${notes.length === 0 ? '  ok ' : '  -- '}${String(Date.now() - started).padStart(5)}ms  ${phrase}${
            notes.length === 0 ? '' : `  →  ${notes.join(', ')}`
          }`,
        );
      }
      lines.push(`   ${String(passed)}/${String(PHRASES.length)} as a person would put them\n`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);
    expect(PHRASES.length).toBeGreaterThan(0);
  });
});
