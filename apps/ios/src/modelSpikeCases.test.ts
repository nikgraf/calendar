import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { SPIKE_CASES } from './modelSpikeCases.ts';

const CASES_DIR = join(import.meta.dirname, '..', '..', 'desktop', 'e2e', 'bench', 'cases');

describe('SPIKE_CASES', () => {
  it('is the first phrase of every bench case, as the case has it now', () => {
    const fromCases = readdirSync(CASES_DIR)
      .filter((file) => file.endsWith('.json'))
      .sort()
      .map((file) => {
        const benchCase = JSON.parse(readFileSync(join(CASES_DIR, file), 'utf8')) as {
          lang: string;
          turns: ReadonlyArray<{ input: { text?: string; transcript?: string } }>;
        };
        const input = benchCase.turns[0]?.input;
        return {
          id: basename(file, '.json'),
          lang: benchCase.lang,
          text: input?.text ?? input?.transcript,
        };
      });
    // A difference: run `node apps/ios/scripts/model-spike-cases.mjs`.
    expect(SPIKE_CASES).toEqual(fromCases);
  });
});
