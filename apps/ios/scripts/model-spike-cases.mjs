// Writes apps/ios/src/modelSpikeCases.ts from the model bench's cases: the
// first phrase of each, which the measurement page (Settings › Advanced ›
// Model Spike) runs on the phone. Run it after a case changes, then
// `pnpm fix` for the formatting; modelSpikeCases.test.ts fails until the
// two agree.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
const casesDir = join(root, 'apps', 'desktop', 'e2e', 'bench', 'cases');
const quote = (text) =>
  `'${text.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`)}'`;

const rows = readdirSync(casesDir)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => {
    const benchCase = JSON.parse(readFileSync(join(casesDir, file), 'utf8'));
    const { input } = benchCase.turns[0];
    return `  { id: ${quote(basename(file, '.json'))}, lang: ${quote(benchCase.lang)}, text: ${quote(input.text ?? input.transcript)} },`;
  });

writeFileSync(
  join(root, 'apps', 'ios', 'src', 'modelSpikeCases.ts'),
  `/**
 * The first phrase of every model bench case
 * (\`apps/desktop/e2e/bench/cases/*.json\`), copied here because the phone
 * cannot read the desktop's files. \`modelSpikeCases.test.ts\` fails when
 * the copy and the cases differ: change a case, then run
 * \`node apps/ios/scripts/model-spike-cases.mjs\` to write this file again.
 * A phrase that was recorded is its transcript.
 */
export interface SpikeCase {
  /** The bench case's file name: the Mac scores the phone's answer by it. */
  readonly id: string;
  readonly lang: 'de' | 'en';
  readonly text: string;
}

export const SPIKE_CASES: ReadonlyArray<SpikeCase> = [
${rows.join('\n')}
];
`,
);
