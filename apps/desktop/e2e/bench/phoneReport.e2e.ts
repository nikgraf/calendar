import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { loadCases, loadContacts } from './cases.ts';
import { comparePhone, type PhoneReport, scorePhoneReport } from './phoneReport.ts';
import { type BenchReport, formatReport, writeReport } from './report.ts';

/**
 * Scores a report shared from the iOS app's Model Spike page with the
 * bench's checks, without asking any model:
 *
 *   E2E=1 MODEL_BENCH_PHONE=<the shared .json> pnpm exec vp test run apps/desktop/e2e/bench/phoneReport.e2e.ts
 *
 * MODEL_BENCH_COMPARE names a Mac report of the same model (the `app`
 * arm): the phone answers first phrases only, so the two are compared on
 * first turns. MODEL_BENCH_OUT is the folder the scored report is written
 * to (output/bench).
 */

const BENCH_DIR = import.meta.dirname;
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

const gitSha = (): string => {
  try {
    return execFileSync('git', ['rev-parse', '--short=8', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim();
  } catch {
    return 'unknown';
  }
};

const phonePath = process.env['MODEL_BENCH_PHONE'];

describe.skipIf(phonePath === undefined || phonePath === '')('phone report', () => {
  it('scores the phone’s first phrases and writes a report', async () => {
    const phone = JSON.parse(readFileSync(phonePath!, 'utf8')) as PhoneReport;
    const { left, report } = await scorePhoneReport(
      phone,
      loadCases(join(BENCH_DIR, 'cases')),
      loadContacts(join(BENCH_DIR, 'contacts.json')),
      gitSha(),
    );
    const lines = [
      `\nPHONE REPORT — run ${phone.when}, today ${phone.today}\n`,
      formatReport(report),
    ];
    if (left.length > 0) {
      lines.push(`   not scored (the case is gone or says other words now): ${left.join(', ')}`);
    }
    const compareWith = process.env['MODEL_BENCH_COMPARE'];
    if (compareWith) {
      lines.push(
        comparePhone(report, JSON.parse(readFileSync(compareWith, 'utf8')) as BenchReport),
      );
    }
    const outDir = process.env['MODEL_BENCH_OUT'] ?? join(ROOT, 'output', 'bench');
    lines.push(`   report: ${writeReport(outDir, report)}\n`);
    process.stdout.write(`${lines.join('\n')}\n`);
    expect(report.cases.length + left.length).toBe(phone.rows.length);
  });
});
