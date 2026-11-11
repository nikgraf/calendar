import type { BenchCase } from './cases.ts';
import { type BenchDraft, check, checkWithoutDraft, type Outcome } from './check.ts';
import { type BenchReport, type CaseReport, scoreOf, type TurnReport } from './report.ts';

/** The notes of a turn that are about its recording or its missing draft, not about a check. */
const KEPT_NOTE = /^(?:recording not read: |no draft to change$)/u;

/**
 * An earlier report scored again by the checks as they are now, without
 * asking the model: each turn's stored outcome is checked against its
 * case, the draft before it being the last one the report holds. For a
 * change to the checks or to an expectation alone; a changed prompt,
 * pipeline or provider needs a run. A case that is gone, or has other
 * turns than the report, stays as the report had it.
 */
export const rescore = (
  report: BenchReport,
  cases: ReadonlyArray<BenchCase>,
  { sha, when }: { readonly sha: string; readonly when: string },
): BenchReport => {
  const byId = new Map(cases.map((benchCase) => [benchCase.id, benchCase]));
  const rescored = report.cases.map((caseReport): CaseReport => {
    const benchCase = byId.get(caseReport.id);
    if (benchCase === undefined || benchCase.turns.length !== caseReport.turns.length) {
      return caseReport;
    }
    let draft: BenchDraft | undefined;
    const turns = caseReport.turns.map((turn, index): TurnReport => {
      const { expect: expectation } = benchCase.turns[index]!;
      // A report holds the outcome as JSON; no outcome means the first
      // phrase had made no draft for this turn to change.
      const stored = turn.outcome as Outcome | null | undefined;
      const ran = stored !== undefined && stored !== null;
      const result = ran
        ? check(expectation, stored, draft, report.today)
        : checkWithoutDraft(expectation, report.today);
      if (ran && stored.kind === 'draft') {
        ({ draft } = stored);
      }
      return {
        ...turn,
        checked: result.checked,
        failed: result.failed,
        notes: [...(ran ? result.notes : []), ...turn.notes.filter((note) => KEPT_NOTE.test(note))],
      };
    });
    return { ...caseReport, ok: turns.every((turn) => turn.failed.length === 0), turns };
  });
  return {
    ...report,
    cases: rescored,
    rescored: { sha: report.sha, when: report.when },
    score: scoreOf(rescored),
    sha,
    when,
  };
};
