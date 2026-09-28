import { meetingUrl } from '../meeting.ts';
import { canonicalReminders } from '../notifications/eventReminders.ts';
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
  /** The rule as the repeat form holds it, when it came from a task (never re-read from `recurrence`). */
  readonly repeat?: TaskRecurrence | undefined;
  readonly startTime: string;
  readonly startTimeZone?: string | undefined;
  /** See `EventConvertSource.timeChosen`. */
  readonly timeChosen: boolean;
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
 * URL; the task editor folds it into the notes if the list it finally
 * saves to is a Google one. The calendar-default notifications become
 * explicit alarms the way a move to Apple resolves them; a rule a
 * reminder can express is carried; an unchosen slot default is no time.
 */
export const eventValuesToTaskValues = (
  values: EventConvertValues,
  timeZone: string,
): TaskConvertValues => {
  const link = values.hangoutLink ?? meetingUrl(values) ?? nonEmpty(values.url);
  const popupMinutes = values.reminders.useDefault
    ? values.defaultReminderMinutes
    : values.reminders.overrides
        .filter((override) => override.method === 'popup')
        .map((override) => override.minutes);
  const timed = !values.isAllDay && values.timeChosen;
  const recurrence = taskRecurrenceFromLines(values.recurrence, {
    isAllDay: values.isAllDay,
    ...(timed ? { startTime: values.startTime } : {}),
    timeZone: values.startTimeZone ?? timeZone,
  });
  return {
    alarms: popupMinutes.map((minutes) => -minutes),
    completed: false,
    dueDate: values.date,
    ...(timed ? { dueTime: values.startTime } : {}),
    notes: nonEmpty(values.description) ?? '',
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
 * notifications; the URL travels as the event URL and the event editor
 * folds it into the description if it finally saves to Google; the rule
 * is carried as the repeat form holds it, so its end date survives.
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
  const description = nonEmpty(values.notes);
  return {
    attendees: [],
    date: values.dueDate,
    defaultReminderMinutes: [],
    ...(description === undefined ? {} : { description }),
    endTime: times.endTime,
    isAllDay,
    // No alarms: the same reminders a new event gets (its calendar's
    // defaults on Google, none on Apple).
    reminders: canonicalReminders(
      new EventReminders({
        overrides: popups,
        useDefault: popups.length === 0 && target === 'google',
      }),
    ),
    ...(values.recurrence === undefined ? {} : { repeat: values.recurrence }),
    startTime: times.startTime,
    timeChosen: true,
    title: values.title,
    ...(nonEmpty(values.url) === undefined ? {} : { url: values.url }),
  };
};
