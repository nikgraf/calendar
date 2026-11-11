import type { BenchCase, Expectation } from './cases.ts';
import { type BenchDraft, check, checkWithoutDraft, type Outcome } from './check.ts';
import { type BenchReport, type CaseReport, scoreOf, type TurnReport } from './report.ts';

/** The notes of a turn that are about its recording or its missing draft, not about a check. */
const KEPT_NOTE = /^(?:recording not read: |no draft to change$)/u;

/**
 * Whose fault a failing recorded turn was, scored again: the transcript's
 * stored outcome held to the same expectation and the same draft before
 * the turn. A report that kept the verdict alone gets none, since a
 * verdict by the earlier checks is not this scoring's to repeat.
 */
const saidAgain = (
  turn: TurnReport,
  expectation: Expectation,
  before: BenchDraft | undefined,
  today: string,
): TurnReport['said'] => {
  const outcome = turn.said?.outcome as Outcome | null | undefined;
  if (outcome === undefined || outcome === null) {
    return undefined;
  }
  const again = check(expectation, outcome, before, today);
  return { notes: again.notes, ok: again.failed.length === 0, outcome };
};

/**
 * An earlier report scored again by the checks as they are now, without
 * asking the model: each turn's stored outcome is checked against its
 * case, the draft before it being the last one the report holds, and so
 * is the transcript's own outcome where a recorded turn fails. For a
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
      // A turn that passes now has no fault to place.
      const said =
        result.failed.length === 0 ? undefined : saidAgain(turn, expectation, draft, report.today);
      if (ran && stored.kind === 'draft') {
        ({ draft } = stored);
      }
      return {
        ...turn,
        checked: result.checked,
        failed: result.failed,
        notes: [...(ran ? result.notes : []), ...turn.notes.filter((note) => KEPT_NOTE.test(note))],
        said,
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
