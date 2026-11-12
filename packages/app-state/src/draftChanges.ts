import {
  type AttendeeInput,
  canonicalReminders,
  emailKey,
  type EventReminders,
  reminderLabel,
  Temporal,
} from '@calendar/core';
import { guestLabel } from './draftInvitees.ts';
import { remindersKey } from './eventEditorChanges.ts';
import type { Draft } from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import { recurrenceKey, type RepeatFields } from './repeatState.ts';

/**
 * What differs between two states of a draft, field by field and in
 * words. A turn's summary names the fields of the item (`summarizeChange`);
 * a step's card, the marks in the form and the trace on the calendar read
 * every field with what it was and what it is (`draftChanges`). Values are
 * compared as what they mean — a rule by its values, guests by address,
 * notifications in their stored form — so a draft that went through the
 * form and came back the same reads as unchanged.
 */

/**
 * "Fri, Aug 28". A day the form holds mid-edit ('' or half typed) is no
 * date: it reads as typed, so a comparison made on every keystroke never
 * throws.
 */
const dayLabel = (date: string): string => {
  try {
    return Temporal.PlainDate.from(date).toLocaleString('en-US', {
      day: 'numeric',
      month: 'short',
      weekday: 'short',
    });
  } catch {
    return date;
  }
};

/** The day an event draft ends on, when it is not the day it starts. */
export const lastDayOf = (item: QuickAddItem): string | undefined =>
  item.kind === 'event' &&
  item.prefill.endDate !== undefined &&
  item.prefill.endDate !== item.prefill.date
    ? item.prefill.endDate
    : undefined;

/**
 * "Fri, Aug 28 · 19:00–20:00", "Fri, Aug 28" for an all-day event, "Tue,
 * Aug 25 · 09:30" for a to-do; a draft over several days names both
 * ("Fri, Aug 28 – Sun, Aug 30", "Fri, Aug 28 · 23:00 – Sat, Aug 29 · 01:00").
 */
export const describeDraftItem = (item: QuickAddItem): string => {
  const day = dayLabel(item.prefill.date);
  if (item.kind === 'task') {
    return item.prefill.time === undefined ? day : `${day} · ${item.prefill.time}`;
  }
  const last = lastDayOf(item);
  if (last !== undefined) {
    return item.prefill.isAllDay
      ? `${day} – ${dayLabel(last)}`
      : `${day} · ${item.prefill.startTime} – ${dayLabel(last)} · ${item.prefill.endTime}`;
  }
  return item.prefill.isAllDay ? day : `${day} · ${item.prefill.startTime}–${item.prefill.endTime}`;
};

const timesOf = (item: QuickAddItem): string =>
  item.kind === 'task'
    ? (item.prefill.time ?? 'no time')
    : item.prefill.isAllDay
      ? 'all day'
      : `${item.prefill.startTime}–${item.prefill.endTime}`;

const dayOf = (item: QuickAddItem): string => {
  const last = lastDayOf(item);
  return last === undefined
    ? dayLabel(item.prefill.date)
    : `${dayLabel(item.prefill.date)} – ${dayLabel(last)}`;
};

const repeatOf = (item: QuickAddItem): string | undefined =>
  item.kind === 'event' && item.prefill.recurrence
    ? `repeats ${item.prefill.recurrence.freq}`
    : undefined;

const placeOf = (item: QuickAddItem): string | undefined =>
  item.kind === 'event' ? item.prefill.location : undefined;

/** An event's repeat rule by its values (`recurrenceKey`); a to-do's item carries none. */
const ruleOf = (item: QuickAddItem): string =>
  recurrenceKey(item.kind === 'event' ? item.prefill.recurrence : undefined);

/** A part of the form a turn can change: what the summary names and the form flashes. */
export type DraftField = 'date' | 'kind' | 'location' | 'repeat' | 'time' | 'title';

/** The fields that differ between two items, in the order the summary names them. */
export const changedDraftFields = (
  before: QuickAddItem,
  after: QuickAddItem,
): ReadonlyArray<DraftField> => [
  ...(before.kind === after.kind ? [] : ['kind' as const]),
  ...(before.prefill.title === after.prefill.title ? [] : ['title' as const]),
  ...(before.prefill.date === after.prefill.date && lastDayOf(before) === lastDayOf(after)
    ? []
    : ['date' as const]),
  ...(timesOf(before) === timesOf(after) ? [] : ['time' as const]),
  ...(placeOf(before) === placeOf(after) ? [] : ['location' as const]),
  ...(ruleOf(before) === ruleOf(after) ? [] : ['repeat' as const]),
];

/**
 * What a refinement changed, field by field ("→ 20:00–21:00 · → Thu, Aug
 * 27"), or "no change" when the words changed nothing the form holds.
 */
export const summarizeChange = (before: QuickAddItem, after: QuickAddItem): string => {
  const said: Record<DraftField, () => string> = {
    date: () => `→ ${dayOf(after)}`,
    kind: () => `→ ${after.kind === 'task' ? 'a to-do' : 'an event'}`,
    location: () => {
      const place = placeOf(after);
      return place === undefined ? '→ no place' : `→ ${place}`;
    },
    repeat: () => `→ ${repeatOf(after) ?? 'does not repeat'}`,
    time: () => `→ ${timesOf(after)}`,
    title: () => `→ “${after.prefill.title}”`,
  };
  const parts = changedDraftFields(before, after).map((field) => said[field]());
  return parts.length === 0 ? 'no change' : parts.join(' · ');
};

/**
 * A part of a draft a step can change: the item's own fields, and what
 * the form holds beyond them.
 */
export type StepField =
  | DraftField
  | 'alert'
  | 'calendar'
  | 'guests'
  | 'list'
  | 'notes'
  | 'priority'
  | 'reminders'
  | 'url';

const FIELD_NAMES: Record<StepField, string> = {
  alert: 'Alert',
  calendar: 'Calendar',
  date: 'Day',
  guests: 'Guests',
  kind: 'Kind',
  list: 'List',
  location: 'Place',
  notes: 'Notes',
  priority: 'Priority',
  reminders: 'Notifications',
  repeat: 'Repeat',
  time: 'Time',
  title: 'Title',
  url: 'URL',
};

/** A field as a step names it: "Time", "Place", "Guests". */
export const fieldName = (field: StepField): string => FIELD_NAMES[field];

/** One field a step changed, in words: what it read before and what it reads now. */
export interface FieldChange {
  /** The guests the step invited, by label. */
  readonly added?: ReadonlyArray<string> | undefined;
  readonly field: StepField;
  /** Undefined: there was nothing (no place, no draft yet). */
  readonly from: string | undefined;
  /** The guests the step took off, by label. */
  readonly removed?: ReadonlyArray<string> | undefined;
  /** Undefined: there is nothing now (the place was cleared). */
  readonly to: string | undefined;
}

/** How a calendar or a list is named in a change; its key when nothing names it. */
export interface ChangeLabels {
  readonly calendar?: ((key: string) => string) | undefined;
  readonly list?: ((key: string) => string) | undefined;
}

const kindLabel = (item: QuickAddItem): string => (item.kind === 'task' ? 'To-do' : 'Event');

/** A to-do the form let go of the day of has none; everything else is on its day. */
const isUndated = (draft: Draft): boolean =>
  draft.item.kind === 'task' && draft.extras?.undated === true;

const dayText = (draft: Draft): string => (isUndated(draft) ? 'No due date' : dayOf(draft.item));

const dayKey = (draft: Draft): string =>
  isUndated(draft) ? 'undated' : `${draft.item.prefill.date}|${lastDayOf(draft.item) ?? ''}`;

/** A to-do's repeat fields by what they say: one that does not repeat is the same however it was typed. */
const fieldsRule = (repeat: RepeatFields | undefined): string =>
  repeat === undefined || repeat.repeat === 'none' ? 'none' : JSON.stringify(repeat);

const repeatKey = (draft: Draft): string =>
  draft.item.kind === 'event' ? ruleOf(draft.item) : fieldsRule(draft.extras?.reminder?.repeat);

const repeatText = (draft: Draft): string | undefined => {
  if (draft.item.kind === 'event') {
    return repeatOf(draft.item);
  }
  const repeat = draft.extras?.reminder?.repeat;
  return repeat === undefined || repeat.repeat === 'none' ? undefined : `repeats ${repeat.repeat}`;
};

/** An event's guests; a to-do has none. */
const guestsOf = (draft: Draft | undefined): ReadonlyArray<AttendeeInput> =>
  draft?.item.kind === 'event' ? (draft.extras?.attendees ?? []) : [];

/** The notes the form holds for the draft as the kind it is. */
const notesOf = (draft: Draft | undefined): string =>
  (draft?.item.kind === 'task'
    ? (draft.extras?.taskNotes ?? '')
    : (draft?.extras?.description ?? '')
  ).trim();

const remindersText = (reminders: EventReminders | undefined, isAllDay: boolean): string => {
  if (reminders === undefined || reminders.useDefault) {
    return 'Calendar default';
  }
  const { overrides } = canonicalReminders(reminders);
  return overrides.length === 0
    ? 'None'
    : overrides.map((override) => reminderLabel(override.minutes, isAllDay)).join(', ');
};

const alertText = (minutes: number | undefined): string =>
  minutes === undefined ? 'None' : reminderLabel(minutes, false);

const priorityText = (priority: string | undefined): string =>
  priority === undefined ? 'None' : priority.charAt(0).toUpperCase() + priority.slice(1);

/** One change when the values differ by `key`, none when they do not. */
const differs = (
  field: StepField,
  keys: readonly [unknown, unknown],
  from: string | undefined,
  to: string | undefined,
): ReadonlyArray<FieldChange> => (keys[0] === keys[1] ? [] : [{ field, from, to }]);

/** The item's own fields: what a phrase can say. */
const itemChanges = (before: Draft | undefined, after: Draft): ReadonlyArray<FieldChange> => {
  const was = before?.item;
  const now = after.item;
  return [
    ...(was === undefined
      ? []
      : differs('kind', [was.kind, now.kind], kindLabel(was), kindLabel(now))),
    ...differs(
      'title',
      [was?.prefill.title ?? '', now.prefill.title],
      was?.prefill.title || undefined,
      now.prefill.title || undefined,
    ),
    ...differs(
      'date',
      [before ? dayKey(before) : undefined, dayKey(after)],
      before ? dayText(before) : undefined,
      dayText(after),
    ),
    ...differs(
      'time',
      [was ? timesOf(was) : undefined, timesOf(now)],
      was ? timesOf(was) : undefined,
      timesOf(now),
    ),
    ...differs(
      'location',
      [(was ? placeOf(was) : undefined) ?? '', placeOf(now) ?? ''],
      was ? placeOf(was) : undefined,
      placeOf(now),
    ),
    ...differs(
      'repeat',
      [before ? repeatKey(before) : 'none', repeatKey(after)],
      before ? repeatText(before) : undefined,
      repeatText(after),
    ),
  ];
};

/** The guests that joined or left, by address; their order says nothing. */
const guestChanges = (before: Draft | undefined, after: Draft): ReadonlyArray<FieldChange> => {
  const was = guestsOf(before);
  const now = guestsOf(after);
  const had = new Set(was.map((guest) => emailKey(guest.email)));
  const has = new Set(now.map((guest) => emailKey(guest.email)));
  const added = now.filter((guest) => !had.has(emailKey(guest.email))).map(guestLabel);
  const removed = was.filter((guest) => !has.has(emailKey(guest.email))).map(guestLabel);
  if (added.length === 0 && removed.length === 0) {
    return [];
  }
  return [
    {
      added,
      field: 'guests',
      from: was.length === 0 ? undefined : was.map(guestLabel).join(', '),
      removed,
      to: now.length === 0 ? undefined : now.map(guestLabel).join(', '),
    },
  ];
};

/** A calendar or list by the name the caller gives it, else by its key. */
const named = (label: ((key: string) => string) | undefined, key: string): string =>
  label?.(key) ?? key;

/** A pick among the form's calendars or lists; a draft the form never held has made none. */
const placeChanges = (
  before: Draft | undefined,
  after: Draft,
  labels: ChangeLabels,
): ReadonlyArray<FieldChange> => {
  const calendars = [before?.extras?.calendarKey, after.extras?.calendarKey] as const;
  const lists = [before?.extras?.listKey, after.extras?.listKey] as const;
  return [
    ...(after.item.kind === 'event' && calendars[0] !== undefined && calendars[1] !== undefined
      ? differs(
          'calendar',
          calendars,
          named(labels.calendar, calendars[0]),
          named(labels.calendar, calendars[1]),
        )
      : []),
    ...(after.item.kind === 'task' && lists[0] !== undefined && lists[1] !== undefined
      ? differs('list', lists, named(labels.list, lists[0]), named(labels.list, lists[1]))
      : []),
  ];
};

/** A reminder's own fields, once the form has held the draft as one on both sides. */
const reminderChanges = (before: Draft | undefined, after: Draft): ReadonlyArray<FieldChange> => {
  const was = before?.extras?.reminder;
  const now = after.extras?.reminder;
  if (after.item.kind !== 'task' || was === undefined || now === undefined) {
    return [];
  }
  return [
    ...differs(
      'priority',
      [was.priority, now.priority],
      priorityText(was.priority),
      priorityText(now.priority),
    ),
    ...differs(
      'alert',
      [was.alarms[0], now.alarms[0]],
      alertText(was.alarms[0]),
      alertText(now.alarms[0]),
    ),
    ...differs(
      'url',
      [was.url.trim(), now.url.trim()],
      was.url.trim() || undefined,
      now.url.trim() || undefined,
    ),
  ];
};

/**
 * Every field that differs between two states of a draft, in the order a
 * card lists them, each with what it read and what it reads. `before`
 * undefined: the step made the draft, so every field it has is new.
 */
export const draftChanges = (
  before: Draft | undefined,
  after: Draft,
  labels: ChangeLabels = {},
): ReadonlyArray<FieldChange> => {
  const isAllDay = after.item.kind === 'event' && after.item.prefill.isAllDay;
  const reminders = [
    before?.item.kind === 'event' ? before.extras?.reminders : undefined,
    after.item.kind === 'event' ? after.extras?.reminders : undefined,
  ] as const;
  return [
    ...itemChanges(before, after),
    ...guestChanges(before, after),
    ...differs(
      'notes',
      [notesOf(before), notesOf(after)],
      notesOf(before) || undefined,
      notesOf(after) || undefined,
    ),
    ...(after.item.kind === 'event'
      ? differs(
          'reminders',
          [remindersKey(reminders[0]), remindersKey(reminders[1])],
          before === undefined ? undefined : remindersText(reminders[0], isAllDay),
          remindersText(reminders[1], isAllDay),
        )
      : []),
    ...placeChanges(before, after, labels),
    ...reminderChanges(before, after),
  ];
};

/** The fields among the changes: what the form marks. */
export const changedFields = (changes: ReadonlyArray<FieldChange>): ReadonlySet<StepField> =>
  new Set(changes.map((change) => change.field));
