import { Temporal } from '../time/temporal.ts';
import { BirthdayOccurrence, BirthdayRecord, type BirthdaySourceRef } from '../types.ts';

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * The identity a person keeps across address books: their name, folded
 * (diacritics stripped, case and whitespace normalised), plus the month
 * and day. Two different birth years under one name are two people.
 */
export const birthdayMergeKey = (record: {
  readonly day: number;
  readonly displayName: string;
  readonly month: number;
}): string => {
  const name = record.displayName
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/\s+/g, ' ')
    .trim();
  return `${name}:${pad2(record.month)}-${pad2(record.day)}`;
};

const sourceOrder = (source: BirthdaySourceRef): number => (source.source === 'google' ? 0 : 1);

/**
 * Folds the same person from Google and the device into one record. A
 * record only joins a group when its year agrees with the group's, or one
 * of them has none. Sources list Google first; the id follows the first
 * source, so a person present in both keeps a stable id across device
 * re-syncs.
 */
export const mergeBirthdays = (
  records: ReadonlyArray<BirthdayRecord>,
): ReadonlyArray<BirthdayRecord> => {
  const groups = new Map<string, Array<BirthdayRecord>>();
  for (const record of records) {
    const key = birthdayMergeKey(record);
    const candidates = groups.get(key) ?? [];
    groups.set(key, candidates);
    const match = candidates.find(
      (candidate) =>
        candidate.year === undefined || record.year === undefined || candidate.year === record.year,
    );
    if (match) {
      const sources = [...match.sources, ...record.sources].sort(
        (a, b) => sourceOrder(a) - sourceOrder(b),
      );
      candidates[candidates.indexOf(match)] = new BirthdayRecord({
        day: match.day,
        displayName: match.displayName,
        id: sources[0]!.id,
        month: match.month,
        sources,
        year: match.year ?? record.year,
      });
    } else {
      candidates.push(record);
    }
  }
  return [...groups.values()].flat();
};

/**
 * The days each birthday falls on inside [startDate, endDate] (inclusive
 * ISO dates). Feb 29 lands on Feb 28 in a common year, as Contacts and
 * Google both display it. Sorted by date, then name.
 */
export const birthdaysInRange = (
  records: ReadonlyArray<BirthdayRecord>,
  startDate: string,
  endDate: string,
): ReadonlyArray<BirthdayOccurrence> => {
  const start = Temporal.PlainDate.from(startDate);
  const end = Temporal.PlainDate.from(endDate);
  const out: Array<BirthdayOccurrence> = [];
  for (const record of records) {
    for (let year = start.year; year <= end.year; year += 1) {
      const date = Temporal.PlainDate.from(
        { day: record.day, month: record.month, year },
        { overflow: 'constrain' },
      );
      if (
        Temporal.PlainDate.compare(date, start) < 0 ||
        Temporal.PlainDate.compare(date, end) > 0
      ) {
        continue;
      }
      out.push(
        new BirthdayOccurrence({
          age: record.year !== undefined && year > record.year ? year - record.year : undefined,
          date: date.toString(),
          record,
        }),
      );
    }
  }
  return out.sort(
    (a, b) =>
      a.date.localeCompare(b.date) || a.record.displayName.localeCompare(b.record.displayName),
  );
};

/** What the detail view says: the next occurrence from `todayIso` and the age it brings. */
export const describeBirthday = (
  record: Pick<BirthdayRecord, 'day' | 'month' | 'year'>,
  todayIso: string,
): { readonly ageTurning?: number; readonly daysUntil: number; readonly nextDate: string } => {
  const today = Temporal.PlainDate.from(todayIso);
  let next = Temporal.PlainDate.from(
    { day: record.day, month: record.month, year: today.year },
    { overflow: 'constrain' },
  );
  if (Temporal.PlainDate.compare(next, today) < 0) {
    next = Temporal.PlainDate.from(
      { day: record.day, month: record.month, year: today.year + 1 },
      { overflow: 'constrain' },
    );
  }
  const ageTurning =
    record.year !== undefined && next.year > record.year ? next.year - record.year : undefined;
  return {
    ...(ageTurning === undefined ? {} : { ageTurning }),
    daysUntil: today.until(next).days,
    nextDate: next.toString(),
  };
};
