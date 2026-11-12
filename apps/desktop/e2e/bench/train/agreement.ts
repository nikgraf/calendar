import { Temporal } from '@calendar/core';
import { worked } from '../said.ts';
import { TUNED_DRAFT_MARKER } from '../tuned.ts';

/**
 * How a trained model's answer to a held-back turn compares with the
 * answer it was to learn. Both are worked out first (`said.ts`), so a
 * day written "14" and the same day written whole agree, and a model
 * trained on whole dates can be held against one trained on days as
 * said. This says how well a model learned its teacher, not how well it
 * reads people: the bench does that.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value with its keys in one order, so two answers can be compared as text. */
const ordered = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(ordered);
  }
  return isRecord(value)
    ? Object.fromEntries(
        Object.keys(value)
          .sort()
          .map((key) => [key, ordered(value[key])]),
      )
    : value;
};

const textOf = (value: unknown): string => JSON.stringify(ordered(value)) ?? '';

/** The "today" a tuned prompt was written for, and the day of the draft it shows. */
export const promptDates = (
  prompt: string,
): { readonly draftDate?: string; readonly referenceDate: string } | undefined => {
  const today = /(\d{4}-\d{2}-\d{2}) \(today\)/u.exec(prompt)?.[1];
  if (today === undefined) {
    return undefined;
  }
  const draftLine = prompt.split('\n').find((line) => line.startsWith(TUNED_DRAFT_MARKER));
  let draft: unknown;
  try {
    draft =
      draftLine === undefined ? undefined : JSON.parse(draftLine.slice(TUNED_DRAFT_MARKER.length));
  } catch {
    draft = undefined;
  }
  const draftDate =
    isRecord(draft) && typeof draft['date'] === 'string' ? draft['date'] : undefined;
  return { ...(draftDate === undefined ? {} : { draftDate }), referenceDate: today };
};

/** Where a worked-out date lies from the prompt's today. */
export type DateSpan = 'beyond' | 'listed' | 'none' | 'past';

const LISTED_DAYS = 14;

const spanOf = (date: unknown, referenceDate: string): DateSpan => {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
    return 'none';
  }
  let days: number;
  try {
    days = Temporal.PlainDate.from(referenceDate).until(Temporal.PlainDate.from(date)).days;
  } catch {
    return 'none';
  }
  if (days < 0) {
    return 'past';
  }
  return days < LISTED_DAYS ? 'listed' : 'beyond';
};

export interface RowAgreement {
  /** Each part either answer has, and whether the two agree on it once worked out. */
  readonly parts: Readonly<Record<string, boolean>>;
  /** The answers as written are the same. */
  readonly same: boolean;
  /** The answers worked out are the same. */
  readonly sameWorked: boolean;
  /** Where the day to learn lies. */
  readonly span: DateSpan;
  /** The answer to learn holds a day or a repeat written as said. */
  readonly writtenAsSaid: boolean;
}

/** One held-back turn: the answer to learn against the answer given. Undefined for a prompt that is none. */
export const rowAgreement = (
  prompt: string,
  want: unknown,
  got: unknown,
): RowAgreement | undefined => {
  const dates = promptDates(prompt);
  if (dates === undefined) {
    return undefined;
  }
  const wanted = worked(want, dates);
  const given = worked(got, dates);
  const wantedParts = isRecord(wanted) ? wanted : {};
  const givenParts = isRecord(given) ? given : {};
  const parts = Object.fromEntries(
    [...new Set([...Object.keys(wantedParts), ...Object.keys(givenParts)])]
      .sort()
      .map((key) => [key, textOf(wantedParts[key]) === textOf(givenParts[key])]),
  );
  return {
    parts,
    same: textOf(want) === textOf(got),
    sameWorked: isRecord(given) && textOf(wanted) === textOf(given),
    span: spanOf(wantedParts['date'], dates.referenceDate),
    writtenAsSaid: textOf(want) !== textOf(wanted),
  };
};

export interface AgreementTotals {
  readonly byPart: Readonly<Record<string, { readonly agree: number; readonly rows: number }>>;
  readonly bySpan: Readonly<Record<DateSpan, { readonly agree: number; readonly rows: number }>>;
  readonly rows: number;
  readonly same: number;
  readonly sameWorked: number;
  /** Among the rows whose answer to learn is written as said. */
  readonly writtenAsSaid: { readonly rows: number; readonly sameWorked: number };
}

/** The rows of a run, counted. `bySpan` counts agreement on the date alone. */
export const totalsOf = (rows: ReadonlyArray<RowAgreement>): AgreementTotals => {
  const byPart: Record<string, { agree: number; rows: number }> = {};
  const bySpan: Record<DateSpan, { agree: number; rows: number }> = {
    beyond: { agree: 0, rows: 0 },
    listed: { agree: 0, rows: 0 },
    none: { agree: 0, rows: 0 },
    past: { agree: 0, rows: 0 },
  };
  for (const row of rows) {
    for (const [part, agrees] of Object.entries(row.parts)) {
      const tally = (byPart[part] ??= { agree: 0, rows: 0 });
      tally.rows += 1;
      tally.agree += agrees ? 1 : 0;
    }
    bySpan[row.span].rows += 1;
    bySpan[row.span].agree += (row.parts['date'] ?? true) ? 1 : 0;
  }
  const asSaid = rows.filter((row) => row.writtenAsSaid);
  return {
    byPart,
    bySpan,
    rows: rows.length,
    same: rows.filter((row) => row.same).length,
    sameWorked: rows.filter((row) => row.sameWorked).length,
    writtenAsSaid: {
      rows: asSaid.length,
      sameWorked: asSaid.filter((row) => row.sameWorked).length,
    },
  };
};
