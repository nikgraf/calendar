import { meetingUrl } from '../meeting.ts';
import { isDeclinedBySelf } from '../scheduling/busy.ts';
import { TIMED_TASK_LAYOUT_MINUTES, taskCalendarDate } from '../taskTiming.ts';
import { addDaysToPlainDate, plainDateToUtcMs } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import type { EventRecord, TaskRecord } from '../types.ts';

/**
 * One source item as a mirror sees it: an event, an occurrence of a
 * series, a task. Everything a copy could ever take comes from here, so a
 * field that is not in this shape cannot leak into one.
 *
 * `key` is the item's portable identity — the same on every device that
 * can see the source — and is only ever stored hashed (`mirrorKeyHash`).
 */
export interface MirrorItem {
  readonly allDay: boolean;
  readonly declined: boolean;
  readonly description?: string | undefined;
  /** A completed task. */
  readonly done: boolean;
  /** All-day end, exclusive. */
  readonly endDate?: string | undefined;
  readonly endUtc: number;
  /** Marked free: it blocks no time. */
  readonly free: boolean;
  readonly key: string;
  /** The video-call link, when there is one. */
  readonly link?: string | undefined;
  readonly location?: string | undefined;
  /** Private or confidential — or not known yet, which counts as private. */
  readonly private: boolean;
  readonly startDate?: string | undefined;
  readonly startUtc: number;
  readonly title: string;
}

/**
 * A stored Google event, or an expanded occurrence of one. An occurrence
 * is identified by its master and its original start, so an exception
 * moved to another time is still the same item.
 */
export const googleEventMirrorItem = (
  event: EventRecord,
  accountEmail: string | undefined,
): MirrorItem => ({
  allDay: event.isAllDay,
  declined: isDeclinedBySelf(event, accountEmail),
  description: event.description,
  done: false,
  endDate: event.endDate,
  endUtc: event.endUtc,
  free: event.transparency === 'transparent',
  key:
    event.recurringEventId !== undefined && event.originalStartUtc !== undefined
      ? `g|${event.calendarId}|${event.recurringEventId}|${event.originalStartUtc}`
      : `g|${event.calendarId}|${event.id}`,
  link: meetingUrl(event),
  location: event.location,
  // Rows synced before visibility was modelled have none: private until
  // the re-list says otherwise, never the other way round.
  private: event.visibility !== 'default' && event.visibility !== 'public',
  startDate: event.startDate,
  startUtc: event.startUtc,
  title: event.title,
});

const wallClockToUtc = (date: string, time: string, timeZone: string): number =>
  Temporal.PlainDate.from(date).toZonedDateTime({
    plainTime: Temporal.PlainTime.from(time),
    timeZone,
  }).epochMilliseconds;

/**
 * A task as an event, on the day `taskCalendarDate` draws it. A timed
 * reminder still on its due day becomes a short timed event — at its own
 * instant when the reminder carries a zone (`dueUtc`), otherwise at that
 * wall-clock time in the mirror's zone; everything else is all-day.
 */
export const taskMirrorItem = (
  task: TaskRecord & { readonly dueUtc?: number | undefined },
  options: { readonly key: string; readonly timeZone: string; readonly today: string },
): MirrorItem => {
  const day = taskCalendarDate(task, options.today, options.timeZone);
  const shared = {
    declined: false,
    description: task.notes,
    done: task.status === 'completed',
    free: false,
    key: options.key,
    link: task.url,
    private: false,
    title: task.title,
  };
  if (task.dueTime !== undefined && day === task.dueDate) {
    const startUtc = task.dueUtc ?? wallClockToUtc(day, task.dueTime, options.timeZone);
    return {
      ...shared,
      allDay: false,
      endUtc: startUtc + TIMED_TASK_LAYOUT_MINUTES * 60_000,
      startUtc,
    };
  }
  const endDate = addDaysToPlainDate(day, 1);
  return {
    ...shared,
    allDay: true,
    endDate,
    endUtc: plainDateToUtcMs(endDate),
    startDate: day,
    startUtc: plainDateToUtcMs(day),
  };
};
