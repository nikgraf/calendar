import { meetingUrl } from '../meeting.ts';
import { canonicalReminders } from '../notifications/eventReminders.ts';
import { buildRecurrenceRule } from '../recurrence/build.ts';
import { taskRecurrenceFromLines } from '../recurrence/taskRecurrence.ts';
import { slotTimes } from '../time/slotSelection.ts';
import {
  EventReminders,
  ReminderOverride,
  type TaskPriority,
  type TaskProvider,
  type TaskRecurrence,
} from '../types.ts';
import type { AttendeeInput } from '../backend.ts';

/**
 * The field carry between the event and the task editors. Both directions
 * are pure so the create-mode flip (form values in, form values out) and
 * a conversion of a stored record share one mapping; what does not fit is
 * named by `convertLoss.ts`.
 */

/** An event as its editor holds it. */
export interface EventConvertValues {
  readonly attendees: ReadonlyArray<AttendeeInput>;
  readonly date: string;
  /** Popup offsets "calendar default" resolves to on the event's calendar (none on Apple). */
  readonly defaultReminderMinutes: ReadonlyArray<number>;
  readonly description?: string | undefined;
  readonly endTime: string;
  readonly hangoutLink?: string | undefined;
  readonly isAllDay: boolean;
  readonly location?: string | undefined;
  /** RFC 5545 lines. */
  readonly recurrence?: ReadonlyArray<string> | undefined;
  readonly reminders: EventReminders;
  readonly startTime: string;
  readonly startTimeZone?: string | undefined;
  readonly title: string;
  /** Apple events only: the event URL. */
  readonly url?: string | undefined;
}

/** A task as its editor holds it. */
export interface TaskConvertValues {
  /** Minutes relative to the due time (≤ 0 = before/at). */
  readonly alarms: ReadonlyArray<number>;
  readonly completed: boolean;
  readonly dueDate: string;
  readonly dueTime?: string | undefined;
  readonly notes: string;
  readonly priority?: TaskPriority | undefined;
  readonly recurrence?: TaskRecurrence | undefined;
  readonly recurrenceUnsupported?: boolean | undefined;
  readonly title: string;
  readonly url?: string | undefined;
}

/** `link` after `description`, unless the text (or the location) already carries it. */
export const appendLink = (
  description: string | undefined,
  link: string | undefined,
  location?: string | undefined,
): string | undefined =>
  link && !(description ?? '').includes(link) && !(location ?? '').includes(link)
    ? [description, link].filter(Boolean).join('\n\n')
    : description;

const nonEmpty = (text: string | undefined): string | undefined =>
  text !== undefined && text.trim() !== '' ? text : undefined;

/**
 * What a task made from the event's fields holds. The link travels as the
 * URL (a Reminders field) and, for a Google list, inside the notes; the
 * calendar-default notifications become explicit alarms the way a move
 * to Apple resolves them; a rule a reminder can express is carried.
 */
export const eventValuesToTaskValues = (
  values: EventConvertValues,
  target: TaskProvider,
  timeZone: string,
): TaskConvertValues => {
  const link = values.hangoutLink ?? meetingUrl(values) ?? nonEmpty(values.url);
  const popupMinutes = values.reminders.useDefault
    ? values.defaultReminderMinutes
    : values.reminders.overrides
        .filter((override) => override.method === 'popup')
        .map((override) => override.minutes);
  const notes =
    target === 'google'
      ? appendLink(nonEmpty(values.description), link, values.location)
      : nonEmpty(values.description);
  const recurrence = taskRecurrenceFromLines(values.recurrence, {
    isAllDay: values.isAllDay,
    startTime: values.startTime,
    timeZone: values.startTimeZone ?? timeZone,
  });
  return {
    alarms: popupMinutes.map((minutes) => -minutes),
    completed: false,
    dueDate: values.date,
    ...(values.isAllDay ? {} : { dueTime: values.startTime }),
    notes: notes ?? '',
    ...(recurrence === undefined ? {} : { recurrence }),
    title: values.title,
    ...(link === undefined ? {} : { url: link }),
  };
};

const minuteOf = (time: string): number => {
  const [hours, minutes] = time.split(':').map(Number);
  return (hours ?? 0) * 60 + (minutes ?? 0);
};

/**
 * What an event made from the task's fields holds: a timed reminder
 * becomes a one-hour event at its time (the slot-click default), an
 * untimed one an all-day event; alarms before the due time become
 * notifications; the URL is the event's on Apple and rides in the
 * description on Google; a rule is carried as it is.
 */
export const taskValuesToEventValues = (
  values: TaskConvertValues,
  target: TaskProvider,
): EventConvertValues => {
  const isAllDay = values.dueTime === undefined;
  const startMinute = minuteOf(values.dueTime ?? '09:00');
  const times = slotTimes({ endMinute: startMinute + 60, startMinute });
  const popups = values.alarms
    .filter((offset) => offset <= 0)
    .map((offset) => new ReminderOverride({ method: 'popup', minutes: -offset }));
  const description =
    target === 'google'
      ? appendLink(nonEmpty(values.notes), nonEmpty(values.url))
      : nonEmpty(values.notes);
  return {
    attendees: [],
    date: values.dueDate,
    defaultReminderMinutes: [],
    ...(description === undefined ? {} : { description }),
    endTime: times.endTime,
    isAllDay,
    ...(values.recurrence === undefined
      ? {}
      : { recurrence: [buildRecurrenceRule(values.recurrence, isAllDay)] }),
    // No alarms: the same reminders a new event gets (its calendar's
    // defaults on Google, none on Apple).
    reminders: canonicalReminders(
      new EventReminders({
        overrides: popups,
        useDefault: popups.length === 0 && target === 'google',
      }),
    ),
    startTime: times.startTime,
    title: values.title,
    ...(target === 'apple' && nonEmpty(values.url) !== undefined ? { url: values.url } : {}),
  };
};
