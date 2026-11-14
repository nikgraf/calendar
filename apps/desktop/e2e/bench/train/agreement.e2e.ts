import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { openAiModel } from '../providers.ts';
import { isFinderPrompt, type RowAgreement, rowAgreement, totalsOf } from './agreement.ts';

/**
 * A trained model against the held-back turns (`valid.jsonl`): how often
 * it gives the answer it was to learn, the two worked out first.
 *
 *   TRAIN_AGREE=1 E2E=1 TRAIN_AGREE_URL=http://127.0.0.1:8089/v1 TRAIN_AGREE_OUT=<answers.jsonl> \
 *     pnpm exec vp test run apps/desktop/e2e/bench/train/agreement.e2e.ts
 *
 * TRAIN_AGREE_URL is a served model (`serve.py`, `llama-server`); its
 * answers are written to TRAIN_AGREE_OUT. TRAIN_AGREE_ANSWERS scores a
 * file written that way instead of asking, so an earlier model's answers
 * can be held against today's data. TRAIN_AGREE_ROWS names such a file
 * too and keeps only the turns it holds: two models on the same turns.
 * TRAIN_DIR is where `valid.jsonl` is. Find a time's held-back sentences
 * are counted apart, field by field. Never part of `pnpm test`.
 */

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url));

interface Example {
  readonly messages: readonly [{ readonly content: string }, { readonly content: string }];
}

interface Answered {
  readonly got: unknown;
  readonly prompt: string;
}

const readLines = <Line>(path: string): Array<Line> =>
  existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Line)
    : [];

const share = ({ agree, rows }: { readonly agree: number; readonly rows: number }): string =>
  `${String(agree)}/${String(rows)}`;

describe.skipIf(!process.env['TRAIN_AGREE'])('a trained model on the held-back turns', () => {
  it('agrees with the answers it was to learn', { timeout: 120 * 60_000 }, async () => {
    const dir = process.env['TRAIN_DIR'] ?? join(ROOT, 'output', 'bench', 'finetune', 'data');
    const examples = readLines<Example>(join(dir, 'valid.jsonl'));
    expect(examples.length).toBeGreaterThan(0);
    const answersPath = process.env['TRAIN_AGREE_ANSWERS'];
    const given =
      answersPath === undefined
        ? undefined
        : new Map(readLines<Answered>(answersPath).map((row) => [row.prompt, row.got]));
    const rowsPath = process.env['TRAIN_AGREE_ROWS'];
    const only =
      rowsPath === undefined
        ? undefined
        : new Set(readLines<Answered>(rowsPath).map((row) => row.prompt));
    const url = process.env['TRAIN_AGREE_URL'] ?? 'http://127.0.0.1:8089/v1';
    const model = openAiModel(url, 'tuned', undefined);
    const answered: Array<Answered & { readonly want: unknown }> = [];
    const first: Array<RowAgreement> = [];
    const later: Array<RowAgreement> = [];
    const finder: Array<RowAgreement> = [];
    for (const example of examples) {
      const prompt = example.messages[0].content;
      if (
        (only !== undefined && !only.has(prompt)) ||
        (given !== undefined && !given.has(prompt))
      ) {
        continue;
      }
      const want: unknown = JSON.parse(example.messages[1].content);
      let got: unknown;
      if (given === undefined) {
        try {
          got = await model.generateJson({ jsonSchema: undefined, prompt });
        } catch (error) {
          got = error instanceof Error ? error.message : String(error);
        }
      } else {
        got = given.get(prompt);
      }
      answered.push({ got, prompt, want });
      const row = rowAgreement(prompt, want, got);
      if (row !== undefined) {
        (isFinderPrompt(prompt) ? finder : prompt.includes('\nPhrase: ') ? first : later).push(row);
      }
    }
    const outPath = process.env['TRAIN_AGREE_OUT'];
    if (outPath !== undefined && given === undefined) {
      writeFileSync(outPath, `${answered.map((row) => JSON.stringify(row)).join('\n')}\n`);
    }
    const all = totalsOf([...first, ...later]);
    const found = totalsOf(finder);
    const lines = [
      `\nHELD-BACK TURNS — ${given === undefined ? url : (answersPath ?? '')}`,
      `turns ${String(all.rows)} of ${String(examples.length)} · the same once worked out ${String(all.sameWorked)} · as written ${String(all.same)}`,
      `first phrases ${String(totalsOf(first).sameWorked)}/${String(first.length)} · later turns ${String(totalsOf(later).sameWorked)}/${String(later.length)}`,
      `answers to learn written as said: ${String(all.writtenAsSaid.sameWorked)}/${String(all.writtenAsSaid.rows)} the same`,
      `date, by where the day to learn lies: listed ${share(all.bySpan.listed)} · beyond ${share(all.bySpan.beyond)} · past ${share(all.bySpan.past)} · none ${share(all.bySpan.none)}`,
      ...Object.entries(all.byPart)
        .sort(([, a], [, b]) => b.rows - a.rows)
        .map(([part, tally]) => `  ${part.padEnd(18)} ${share(tally)}`),
      ...(finder.length === 0
        ? []
        : [
            `find a time: ${String(found.same)}/${String(found.rows)} sentences the same`,
            ...Object.entries(found.byPart)
              .sort(([, a], [, b]) => b.rows - a.rows)
              .map(([part, tally]) => `  ${part.padEnd(18)} ${share(tally)}`),
          ]),
    ];
    process.stdout.write(`${lines.join('\n')}\n`);
  });
});
