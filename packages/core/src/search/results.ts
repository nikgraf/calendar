import { Schema } from 'effect';
import { addDaysToPlainDate, toZonedDateTime } from '../time/convert.ts';
import { daySpanRange, type UtcRange } from '../time/ranges.ts';
import { Temporal } from '../time/temporal.ts';
import { EventRecord, TaskRecord } from '../types.ts';

/**
 * How many years either side of today event search reads. Events are read
 * the way the views read them — series expanded, Apple events asked of
 * EventKit — so the search needs a window; older or farther events are
 * not found (full-text search over the stored rows is the way past it).
 */
export const SEARCH_WINDOW_YEARS = 2;

/** Results per group; a group's `total` says how many matched. */
export const SEARCH_GROUP_LIMIT = 50;

export class EventSearchHit extends Schema.Class<EventSearchHit>('EventSearchHit')({
  /** The occurrence to show and open: for a series, its next one, else its latest past one. */
  event: EventRecord,
  /** The event repeats: `event` stands for every matching occurrence of its series. */
  repeating: Schema.Boolean,
}) {}

export const EventSearchGroup = Schema.Struct({
  hits: Schema.Array(EventSearchHit),
  /** Matches before the cap: more than `hits.length` when the group was cut short. */
  total: Schema.Number,
});
export type EventSearchGroup = typeof EventSearchGroup.Type;

export const TaskSearchGroup = Schema.Struct({
  tasks: Schema.Array(TaskRecord),
  /** Matches before the cap: more than `tasks.length` when the group was cut short. */
  total: Schema.Number,
});
export type TaskSearchGroup = typeof TaskSearchGroup.Type;

/**
 * What a search found, in the order the UIs list it: events not over yet
 * (soonest first), past events (most recent first), then tasks (open ones
 * by due day, undated ones, then completed ones, latest first).
 */
export const SearchResults = Schema.Struct({
  past: EventSearchGroup,
  tasks: TaskSearchGroup,
  upcoming: EventSearchGroup,
});
export type SearchResults = typeof SearchResults.Type;

export const EMPTY_SEARCH_RESULTS: SearchResults = {
  past: { hits: [], total: 0 },
  tasks: { tasks: [], total: 0 },
  upcoming: { hits: [], total: 0 },
};

/** [start of the day SEARCH_WINDOW_YEARS back, start of the day after as far ahead) in `timeZone`. */
export const searchWindow = (nowMs: number, timeZone: string): UtcRange => {
  const today = toZonedDateTime(nowMs, timeZone).toPlainDate();
  const first = today.subtract({ years: SEARCH_WINDOW_YEARS });
  const last = today.add({ years: SEARCH_WINDOW_YEARS });
  return daySpanRange(first, first.until(last).days + 1, timeZone);
};

type Timing = Pick<EventRecord, 'endDate' | 'endUtc' | 'isAllDay' | 'startDate' | 'startUtc'>;

/**
 * Not over yet, which makes an event or occurrence upcoming: an all-day one
 * until its last day ends in the zone whose date `today` is (its UTC
 * instants are midnight UTC, hours off the zone's day), a timed one until
 * it ends — one under way is the next occurrence, not a past one.
 */
export const isNotOver = (event: Timing, nowMs: number, today: string): boolean =>
  event.isAllDay && event.startDate !== undefined
    ? (event.endDate ?? addDaysToPlainDate(event.startDate, 1)) > today
    : event.endUtc > nowMs || event.startUtc >= nowMs;

/** When the event starts on the zone's clock: an all-day one at its first day's start there. */
const startKey = (event: Timing, timeZone: string): number =>
  event.isAllDay && event.startDate !== undefined
    ? Temporal.PlainDate.from(event.startDate).toZonedDateTime({ timeZone }).epochMilliseconds
    : event.startUtc;

/** Case-insensitive first, then exact: the same order on every machine (no locale). */
const compareText = (a: string, b: string): number => {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
};

/** The same event under one account and calendar: the last tie-break. */
const compareIdentity = (a: EventRecord, b: EventRecord): number =>
  compareText(a.accountId, b.accountId) ||
  compareText(a.calendarId, b.calendarId) ||
  compareText(a.id, b.id);

/** All occurrences of one series share their master: Google's or EventKit's series id. */
const seriesKey = (event: EventRecord): string | undefined =>
  event.recurringEventId === undefined
    ? undefined
    : `${event.accountId}\u0000${event.calendarId}\u0000${event.recurringEventId}`;

const DONE = 2;
const UNDATED = 1;
const DATED = 0;

const taskRank = (task: TaskRecord): number =>
  task.status === 'completed' ? DONE : task.dueDate === undefined ? UNDATED : DATED;

/**
 * Open tasks by due day (timed before untimed on a day, as the views list
 * them), then the undated ones, then completed ones, latest first.
 */
const compareTasks = (a: TaskRecord, b: TaskRecord): number => {
  const rank = taskRank(a) - taskRank(b);
  if (rank !== 0) {
    return rank;
  }
  const order =
    taskRank(a) === DATED
      ? compareText(a.dueDate ?? '', b.dueDate ?? '') ||
        Number(a.dueTime === undefined) - Number(b.dueTime === undefined) ||
        compareText(a.dueTime ?? '', b.dueTime ?? '')
      : taskRank(a) === DONE
        ? (b.completedAt ?? Number.NEGATIVE_INFINITY) - (a.completedAt ?? Number.NEGATIVE_INFINITY)
        : 0;
  return (
    order ||
    compareText(a.title, b.title) ||
    compareText(a.accountId, b.accountId) ||
    compareText(a.listId, b.listId) ||
    compareText(a.id, b.id)
  );
};

/**
 * Orders, collapses and caps what matched a search (see `eventMatchesSearch`
 * / `taskMatchesSearch`). All matching occurrences of one series become one
 * hit: the next occurrence not over yet, else the latest past one. A hit is
 * upcoming until it is over (`isNotOver`), in `timeZone` for all-day ones.
 */
export const buildSearchResults = ({
  events,
  limit = SEARCH_GROUP_LIMIT,
  nowMs,
  tasks,
  timeZone,
}: {
  readonly events: ReadonlyArray<EventRecord>;
  readonly limit?: number;
  readonly nowMs: number;
  readonly tasks: ReadonlyArray<TaskRecord>;
  readonly timeZone: string;
}): SearchResults => {
  const today = toZonedDateTime(nowMs, timeZone).toPlainDate().toString();
  const keyed = events.map((event) => ({
    event,
    start: startKey(event, timeZone),
    upcoming: isNotOver(event, nowMs, today),
  }));
  type Keyed = (typeof keyed)[number];
  const soonestFirst = (a: Keyed, b: Keyed): number =>
    a.start - b.start ||
    Number(b.event.isAllDay) - Number(a.event.isAllDay) ||
    compareText(a.event.title, b.event.title) ||
    compareIdentity(a.event, b.event);
  const latestFirst = (a: Keyed, b: Keyed): number =>
    b.start - a.start ||
    compareText(a.event.title, b.event.title) ||
    compareIdentity(a.event, b.event);

  const hits: Array<{ readonly entry: Keyed; readonly repeating: boolean }> = [];
  const series = new Map<string, Array<Keyed>>();
  for (const entry of keyed) {
    const key = seriesKey(entry.event);
    if (key === undefined) {
      hits.push({ entry, repeating: false });
    } else {
      const occurrences = series.get(key);
      if (occurrences) {
        occurrences.push(entry);
      } else {
        series.set(key, [entry]);
      }
    }
  }
  for (const occurrences of series.values()) {
    const next = occurrences.filter((entry) => entry.upcoming).sort(soonestFirst)[0];
    const chosen = next ?? [...occurrences].sort(latestFirst)[0];
    if (chosen) {
      hits.push({ entry: chosen, repeating: true });
    }
  }

  const group = (
    entries: ReadonlyArray<{ readonly entry: Keyed; readonly repeating: boolean }>,
  ): EventSearchGroup => ({
    hits: entries
      .slice(0, limit)
      .map(({ entry, repeating }) => new EventSearchHit({ event: entry.event, repeating })),
    total: entries.length,
  });
  const sortedTasks = [...tasks].sort(compareTasks);
  return {
    past: group(
      hits.filter(({ entry }) => !entry.upcoming).sort((a, b) => latestFirst(a.entry, b.entry)),
    ),
    tasks: { tasks: sortedTasks.slice(0, limit), total: sortedTasks.length },
    upcoming: group(
      hits.filter(({ entry }) => entry.upcoming).sort((a, b) => soonestFirst(a.entry, b.entry)),
    ),
  };
};
