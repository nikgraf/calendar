import type { QuickAddResult } from '@calendar/ai';
import type { Contact } from '@calendar/core';
import type { BenchCase } from './cases.ts';
import { applyResult, check } from './check.ts';
import { type BenchReport, type CaseReport, scoreOf } from './report.ts';

/**
 * A phone's run scored on the Mac. The iOS app's measurement page
 * (Settings › Advanced › Model Spike, `apps/ios/src/modelSpike.ts`) sends
 * the first phrase of every case through the app's quick-add pipeline on
 * a model loaded into the app, and shares what came back untouched; this
 * file makes each result a draft the way a bench run does and holds it to
 * the case's first expectation. The phone answers first phrases only, so
 * the number to hold it against is a Mac report's first turns
 * (`firstTurns`), not its cases.
 */

/** What this file reads of the phone's report (`SpikeReport` on the iOS side). */
export interface PhoneReport {
  readonly gpu?: boolean | undefined;
  readonly model: { readonly name: string };
  readonly rows: ReadonlyArray<{
    readonly id: string;
    readonly input: string;
    readonly ms: number;
    readonly result: QuickAddResult | { readonly kind: 'failed'; readonly message: string };
  }>;
  readonly timeZone: string;
  readonly today: string;
  readonly when: string;
}

export interface PhoneScore {
  /** Rows left out: their case is gone, or says other words than the phone was given. */
  readonly left: ReadonlyArray<string>;
  /** One turn per case the phone answered: the first. */
  readonly report: BenchReport;
}

const firstWords = (benchCase: BenchCase): string | undefined => {
  const input = benchCase.turns[0]?.input;
  return input === undefined ? undefined : 'text' in input ? input.text : input.transcript;
};

/**
 * The phone's rows as a report of first turns. A row is scored only while
 * its case still says the words the phone read: an answer to other words
 * would fail the model for a changed case.
 */
export const scorePhoneReport = async (
  phone: PhoneReport,
  cases: ReadonlyArray<BenchCase>,
  books: Readonly<Record<string, ReadonlyArray<Contact>>>,
  sha: string,
): Promise<PhoneScore> => {
  const byId = new Map(cases.map((benchCase) => [benchCase.id, benchCase]));
  const left: Array<string> = [];
  const scored: Array<CaseReport> = [];
  for (const row of phone.rows) {
    const benchCase = byId.get(row.id);
    const first = benchCase?.turns[0];
    if (benchCase === undefined || first === undefined || firstWords(benchCase) !== row.input) {
      left.push(row.id);
      continue;
    }
    const outcome =
      row.result.kind === 'failed'
        ? { kind: 'rejected' as const, reason: row.result.message }
        : await applyResult(undefined, row.result, books[benchCase.contacts] ?? []);
    const { checked, failed, notes } = check(first.expect, outcome, undefined, phone.today);
    scored.push({
      id: row.id,
      ok: failed.length === 0,
      tags: benchCase.tags,
      // The phone's calls are numbers, not prompts and answers: its own report keeps them.
      turns: [{ calls: [], checked, failed, input: row.input, ms: row.ms, notes, outcome }],
    });
  }
  return {
    left,
    report: {
      cases: scored,
      provider: `phone:${phone.model.name}${phone.gpu === false ? ' (no GPU)' : ''}`,
      score: scoreOf(scored),
      sha,
      timeZone: phone.timeZone,
      today: phone.today,
      when: phone.when,
    },
  };
};

/**
 * A Mac report's first turns, for the cases the phone answered: what the
 * same model did with the same phrases through the same pipeline.
 */
export const firstTurns = (
  report: BenchReport,
  ids: ReadonlySet<string>,
): { readonly failed: ReadonlyArray<string>; readonly ok: number; readonly total: number } => {
  const firsts = report.cases.filter((benchCase) => ids.has(benchCase.id));
  const failed = firsts
    .filter((benchCase) => (benchCase.turns[0]?.failed.length ?? 1) > 0)
    .map((benchCase) => benchCase.id);
  return { failed, ok: firsts.length - failed.length, total: firsts.length };
};

/** The phone beside the Mac: the counts, and the phrases only one of them got right. */
export const comparePhone = (phone: BenchReport, mac: BenchReport): string => {
  const ids = new Set(phone.cases.map((benchCase) => benchCase.id));
  const onMac = firstTurns(mac, ids);
  const macFailed = new Set(onMac.failed);
  const phoneFailed = new Set(
    phone.cases.filter((benchCase) => !benchCase.ok).map((benchCase) => benchCase.id),
  );
  const onlyPhone = [...ids].filter((id) => macFailed.has(id) && !phoneFailed.has(id));
  const onlyMac = [...ids].filter((id) => phoneFailed.has(id) && !macFailed.has(id));
  return [
    `   first phrases: phone ${String(phone.score.cases.ok)}/${String(phone.score.cases.total)}, ${mac.provider} on the Mac ${String(onMac.ok)}/${String(onMac.total)} (${mac.sha})`,
    ...(onlyMac.length === 0 ? [] : [`   right on the Mac only: ${onlyMac.join(', ')}`]),
    ...(onlyPhone.length === 0 ? [] : [`   right on the phone only: ${onlyPhone.join(', ')}`]),
  ].join('\n');
};
