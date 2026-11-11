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
 * (`comparePhone`), not its cases. The scored report's `sha` is the
 * commit that scored it; the phone's report names none.
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
  /** A simulator made the report: every time in it is the Mac's, through the simulator. */
  readonly simulator?: boolean | undefined;
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
      // The label says where the times are from: a simulator's must never read as a phone's.
      provider: `${phone.simulator === true ? 'simulator' : 'phone'}:${phone.model.name}${phone.gpu === false ? ' (no GPU)' : ''}`,
      score: scoreOf(scored),
      sha,
      timeZone: phone.timeZone,
      today: phone.today,
      when: phone.when,
    },
  };
};

const ids = (list: ReadonlyArray<CaseReport>): string =>
  list.map((benchCase) => benchCase.id).join(', ');

/**
 * The phone beside the Mac, over the first phrases both answered: the same
 * case and the same words. A case the Mac's report lacks (a run of a
 * selection), or read differently (a recording through the recogniser, a
 * case changed since), is no comparison and is named instead.
 */
export const comparePhone = (phone: BenchReport, mac: BenchReport): string => {
  const onMac = new Map(mac.cases.map((benchCase) => [benchCase.id, benchCase.turns[0]]));
  const both = phone.cases.filter(
    (benchCase) => onMac.get(benchCase.id)?.input === benchCase.turns[0]?.input,
  );
  const apart = phone.cases.filter((benchCase) => !both.includes(benchCase));
  const rightOnMac = (id: string): boolean => onMac.get(id)?.failed.length === 0;
  const count = (ok: number): string => `${String(ok)}/${String(both.length)}`;
  const onlyMac = both.filter((benchCase) => !benchCase.ok && rightOnMac(benchCase.id));
  const onlyPhone = both.filter((benchCase) => benchCase.ok && !rightOnMac(benchCase.id));
  return [
    `   first phrases both answered: phone ${count(both.filter((benchCase) => benchCase.ok).length)}, ${mac.provider} on the Mac ${count(both.filter((benchCase) => rightOnMac(benchCase.id)).length)} (${mac.sha})`,
    ...(onlyMac.length === 0 ? [] : [`   right on the Mac only: ${ids(onlyMac)}`]),
    ...(onlyPhone.length === 0 ? [] : [`   right on the phone only: ${ids(onlyPhone)}`]),
    ...(apart.length === 0
      ? []
      : [`   not compared (the Mac's report lacks the case, or read other words): ${ids(apart)}`]),
  ].join('\n');
};
