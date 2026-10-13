import { formatClockTime, formatPlainTime } from '../format.ts';
import { addDaysToPlainDate, toZonedDateTime } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import { formatZoneTimeRange } from '../time/zoneLabels.ts';
import type { EventRecord, TaskRecord } from '../types.ts';
import { cleanSearchQuery, type SearchFilterField, type SearchQuery } from './query.ts';

/** "Tue, Oct 14", with the year once it is not `today`'s. */
const dayLabel = (date: Temporal.PlainDate, today: string): string =>
  date.toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
    ...(date.year === Temporal.PlainDate.from(today).year ? {} : { year: 'numeric' }),
  });

/**
 * When a search hit takes place, in `timeZone`: "Tue, Oct 14 · 9:00 –
 * 10:00 AM", "Fri, Oct 17 · All day", "Fri, Oct 17 – Sun, Oct 19 · All
 * day", or across midnight "Tue, Oct 14, 9:00 PM – Wed, Oct 15, 1:00 AM".
 * A date outside `today`'s year carries its year.
 */
export const searchEventWhen = (
  event: Pick<EventRecord, 'endDate' | 'endUtc' | 'isAllDay' | 'startDate' | 'startUtc'>,
  timeZone: string,
  today: string,
): string => {
  if (event.isAllDay && event.startDate !== undefined) {
    const first = Temporal.PlainDate.from(event.startDate);
    // The end date is exclusive: an event on one day ends on the next.
    const last = Temporal.PlainDate.from(
      addDaysToPlainDate(event.endDate ?? addDaysToPlainDate(event.startDate, 1), -1),
    );
    return Temporal.PlainDate.compare(last, first) > 0
      ? `${dayLabel(first, today)} – ${dayLabel(last, today)} · All day`
      : `${dayLabel(first, today)} · All day`;
  }
  const startDay = toZonedDateTime(event.startUtc, timeZone).toPlainDate();
  // An event ending at midnight still belongs to its start day: one date.
  const lastDay = toZonedDateTime(
    Math.max(event.startUtc, event.endUtc - 1),
    timeZone,
  ).toPlainDate();
  if (startDay.equals(lastDay)) {
    const times = formatZoneTimeRange(event.startUtc, event.endUtc, timeZone);
    return `${dayLabel(startDay, today)} · ${times}`;
  }
  // Longer, its end is named by the day it falls on (midnight: the next one).
  const endDay = toZonedDateTime(event.endUtc, timeZone).toPlainDate();
  const start = `${dayLabel(startDay, today)}, ${formatClockTime(event.startUtc, timeZone)}`;
  const end = `${dayLabel(endDay, today)}, ${formatClockTime(event.endUtc, timeZone)}`;
  return `${start} – ${end}`;
};

/** A task result's date line: "Due Tue, Oct 14", "Due Tue, Oct 14, 9:00 AM" or "No due date". */
export const searchTaskWhen = (
  task: Pick<TaskRecord, 'dueDate' | 'dueTime'>,
  today: string,
): string =>
  task.dueDate === undefined
    ? 'No due date'
    : `Due ${dayLabel(Temporal.PlainDate.from(task.dueDate), today)}${
        task.dueTime === undefined ? '' : `, ${formatPlainTime(task.dueTime)}`
      }`;

/** "Oct 14", with the year once it is not `today`'s. */
const shortDay = (iso: string, today: string): string => {
  const date = Temporal.PlainDate.from(iso);
  return date.toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    ...(date.year === Temporal.PlainDate.from(today).year ? {} : { year: 'numeric' }),
  });
};

/** A search's date range in words: "Oct 1 – Oct 31", "Oct 14", "from Oct 1", "until Oct 31". */
export const searchDateLabel = (
  from: string | undefined,
  to: string | undefined,
  today: string,
): string | undefined => {
  if (from !== undefined && to !== undefined) {
    return from === to
      ? shortDay(from, today)
      : `${shortDay(from, today)} – ${shortDay(to, today)}`;
  }
  if (from !== undefined) {
    return `from ${shortDay(from, today)}`;
  }
  return to === undefined ? undefined : `until ${shortDay(to, today)}`;
};

/** What a search's labels name calendars and lists by, and the day dates are read from. */
export interface SearchNames {
  readonly calendars: ReadonlyArray<{
    readonly accountId: string;
    readonly id: string;
    readonly summary: string;
  }>;
  readonly taskLists: ReadonlyArray<{
    readonly accountId: string;
    readonly id: string;
    readonly title: string;
  }>;
  readonly today: string;
}

/** One filter as the chip row shows it; a calendar or list chip names its key. */
export interface SearchFilterChip {
  readonly field: SearchFilterField;
  readonly key?: string | undefined;
  readonly label: string;
}

const calendarName = (names: SearchNames, key: string): string =>
  names.calendars.find((calendar) => `${calendar.accountId}:${calendar.id}` === key)?.summary ??
  'Calendar';

const listName = (names: SearchNames, key: string): string =>
  names.taskLists.find((list) => `${list.accountId}:${list.id}` === key)?.title ?? 'List';

/**
 * The query's filters as chips, in the order the row shows them: when,
 * which kind, which calendars and lists, where, with whom, all-day or not.
 * The words are the field's, not a chip.
 */
export const searchFilterChips = (
  query: SearchQuery,
  names: SearchNames,
): ReadonlyArray<SearchFilterChip> => {
  const clean = cleanSearchQuery(query);
  const dates = searchDateLabel(clean.from, clean.to, names.today);
  return [
    ...(dates ? [{ field: 'dates' as const, label: dates }] : []),
    ...(clean.kind
      ? [{ field: 'kind' as const, label: clean.kind === 'task' ? 'Tasks only' : 'Events only' }]
      : []),
    ...(clean.calendars ?? []).map((key) => ({
      field: 'calendar' as const,
      key,
      label: calendarName(names, key),
    })),
    ...(clean.lists ?? []).map((key) => ({
      field: 'list' as const,
      key,
      label: listName(names, key),
    })),
    ...(clean.location ? [{ field: 'location' as const, label: `in ${clean.location}` }] : []),
    ...(clean.people
      ? [{ field: 'people' as const, label: `with ${clean.people.join(', ')}` }]
      : []),
    ...(clean.allDay === undefined
      ? []
      : [{ field: 'allDay' as const, label: clean.allDay ? 'All-day' : 'Timed' }]),
  ];
};

/** A chip's identity across queries: its field, and the calendar or list it names. */
export const searchChipId = (chip: SearchFilterChip): string => `${chip.field}:${chip.key ?? ''}`;

/**
 * The chips a turn put in the row or changed — new ones and ones whose
 * label moved ("Last week" → "Last month") — for the row to flash. A
 * filter the turn took away flashes nothing: its chip is gone.
 */
export const changedSearchChips = (
  before: SearchQuery,
  after: SearchQuery,
  names: SearchNames,
): ReadonlyArray<string> => {
  const was = new Map(searchFilterChips(before, names).map((chip) => [searchChipId(chip), chip]));
  return searchFilterChips(after, names)
    .filter((chip) => was.get(searchChipId(chip))?.label !== chip.label)
    .map(searchChipId);
};

/** The query in one line, for "nothing matches …": the words quoted, then the chips. */
export const searchQuerySentence = (query: SearchQuery, names: SearchNames): string => {
  const words = cleanSearchQuery(query).terms.join(' ');
  return [
    ...(words ? [`“${words}”`] : []),
    ...searchFilterChips(query, names).map((chip) => chip.label),
  ].join(' · ');
};

const sameList = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
): boolean =>
  JSON.stringify([...(left ?? [])].sort()) === JSON.stringify([...(right ?? [])].sort());

/**
 * What a turn changed in the query, field by field ("→ “lunch” · → Oct 1
 * – Oct 31 · → in Vienna"; "→ any time" for a range taken away), or "no
 * change" — the search thread's history, like `summarizeChange` for drafts.
 */
export const summarizeSearchChange = (
  before: SearchQuery,
  after: SearchQuery,
  names: SearchNames,
): string => {
  const was = cleanSearchQuery(before);
  const now = cleanSearchQuery(after);
  const parts: Array<string> = [];
  if (was.terms.join(' ') !== now.terms.join(' ')) {
    parts.push(now.terms.length > 0 ? `→ “${now.terms.join(' ')}”` : '→ no words');
  }
  if (was.from !== now.from || was.to !== now.to) {
    parts.push(`→ ${searchDateLabel(now.from, now.to, names.today) ?? 'any time'}`);
  }
  if (was.kind !== now.kind) {
    parts.push(
      now.kind === 'task'
        ? '→ tasks only'
        : now.kind === 'event'
          ? '→ events only'
          : '→ events and tasks',
    );
  }
  if (!sameList(was.calendars, now.calendars)) {
    parts.push(
      now.calendars
        ? `→ ${now.calendars.map((key) => calendarName(names, key)).join(', ')}`
        : '→ any calendar',
    );
  }
  if (!sameList(was.lists, now.lists)) {
    parts.push(
      now.lists ? `→ ${now.lists.map((key) => listName(names, key)).join(', ')}` : '→ any list',
    );
  }
  if (was.location !== now.location) {
    parts.push(now.location ? `→ in ${now.location}` : '→ anywhere');
  }
  if (JSON.stringify(was.people ?? []) !== JSON.stringify(now.people ?? [])) {
    parts.push(now.people ? `→ with ${now.people.join(', ')}` : '→ anyone');
  }
  if (was.allDay !== now.allDay) {
    parts.push(
      now.allDay === undefined ? '→ all-day or timed' : now.allDay ? '→ all-day' : '→ timed',
    );
  }
  return parts.length === 0 ? 'no change' : parts.join(' · ');
};
