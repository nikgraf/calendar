import {
  appendLink,
  byDayError,
  repeatUntilError,
  isCalendarWritable,
  isLossy,
  isTaskToEventLossy,
  moveLossSummary,
  taskRecurrenceFromLines,
  taskToEventLossSummary,
  timeFieldsChanged,
  addDaysToPlainDate,
  buildRecurrenceRule,
  buildEventTimes,
  canonicalReminders,
  daysBetweenPlainDates,
  draftMinutes,
  editorDatesOf,
  emailKey,
  geoMatches,
  meetingUrl,
  openInMapsUrl,
  placeSuggestionLabel,
  slotTimes,
  toZonedDateTime,
  validateEventDraft,
  type Attendee,
  type AttendeeInput,
  type ByDay,
  type CalendarInfo,
  type EventConvertValues,
  type EventDraft,
  type EventRecord,
  EventReminders,
  type FreeSlot,
  type GeoLocation,
  type ItemKind,
  MAX_REMINDER_OVERRIDES,
  type PlaceSuggestion,
  type RecurrenceFrequency,
  type RecurringScope,
  ReminderOverride,
  type RsvpResponse,
  type TaskListInfo,
  type TaskRecord,
  type Temporal,
} from '@calendar/core';
import { useCallback, useRef, useState } from 'react';
import { deleteQuestion } from './deleteQuestion.ts';
import { keptAsSaid, latestWord, locationToLookUp } from './editorLocation.ts';
import { eventEditorChanges, type EventEditorText, vouchedGeo } from './eventEditorChanges.ts';
import { useAccounts, useBackendMutations, useEventMaster, useLocationGeo } from './hooks.ts';
import { useOneWrite } from './oneWrite.ts';
import { useRepeatState } from './repeatState.ts';

/**
 * Fields a parsed phrase can prefill. Structural on purpose so app-state
 * stays independent of the AI package.
 */
export type { RepeatEnds } from './repeatState.ts';

export interface EventEditorPrefill {
  /** The times came from a meal or part-of-day word, not a stated clock time: shown as assumed until set. */
  readonly assumedTime?: boolean | undefined;
  readonly date: string;
  /** The day it ends on, when not `date` (see `EditorTimeFields`): only the form sets one. */
  readonly endDate?: string | undefined;
  readonly endTime: string;
  readonly isAllDay: boolean;
  readonly location?: string | undefined;
  readonly recurrence?:
    | {
        readonly byDay?: ReadonlyArray<ByDay> | undefined;
        readonly count?: number | undefined;
        readonly freq: RecurrenceFrequency;
        readonly interval?: number | undefined;
        readonly untilDate?: string | undefined;
      }
    | undefined;
  readonly startTime: string;
  readonly title: string;
}

/** What an editor is opened with: an existing event, or a prefilled slot. */
export interface EventEditorSeed {
  /** `accountId:calendarId` to create in; wins over the remembered calendar. */
  readonly calendarKey?: string | undefined;
  /**
   * The task this (otherwise new) event replaces: Save converts it — the
   * event is created from the form, then the task is deleted — after
   * confirming what the task holds that an event cannot.
   */
  readonly convertFromTask?: TaskRecord | undefined;
  readonly event?: EventRecord;
  readonly initialDate: Temporal.PlainDate;
  readonly initialHour?: number;
  /**
   * The scope an existing series opens in ('instance' by default). The
   * detail views pass 'series' with a conversion: a series converts as a
   * whole, so the editor must not start on the occurrence.
   */
  readonly initialScope?: RecurringScope | undefined;
  /** A slot drawn on the time grid (`HH:MM`); wins over `initialHour`. */
  readonly initialTimes?: { readonly endTime: string; readonly startTime: string };
  /** Quick-add result: the user reviews it before anything is written. */
  readonly prefill?: EventEditorPrefill;
}

/**
 * The calendar the last event was created in, for this session. A new
 * event used to default to the first writable calendar every time, so a
 * user whose primary calendar is not first kept re-picking it.
 */
let lastUsedCalendarKey: string | null = null;
export const rememberCalendar = (calendarKey: string): void => {
  lastUsedCalendarKey = calendarKey;
};
/** The calendar a new event will default to (a quick-add review names it). */
export const getLastUsedCalendarKey = (): string | null => lastUsedCalendarKey;

/**
 * `key` while it names a calendar a new event can go to, else `fallback`:
 * a calendar remembered for a draft may have gone, or turned read-only,
 * since it was picked.
 */
export const writableCalendarKey = (
  calendars: ReadonlyArray<CalendarInfo>,
  key: string | undefined,
  fallback: string,
): string =>
  key !== undefined &&
  calendars.some(
    (calendar) => isCalendarWritable(calendar) && `${calendar.accountId}:${calendar.id}` === key,
  )
    ? key
    : fallback;

/**
 * The start and end a new event opens with: a quick-add result first, then
 * a slot drawn on the grid, then the clicked hour (one hour long; the last
 * hour ends at 23:59, since `24:00` is no valid time), then 09:00.
 */
export const seedTimeFields = (seed: EventEditorSeed): { endTime: string; startTime: string } => {
  const hour = seed.initialHour ?? 9;
  const clicked = slotTimes({ endMinute: (hour + 1) * 60, startMinute: hour * 60 });
  return {
    endTime: seed.prefill?.endTime ?? seed.initialTimes?.endTime ?? clicked.endTime,
    startTime: seed.prefill?.startTime ?? seed.initialTimes?.startTime ?? clicked.startTime,
  };
};

/**
 * Calendars bucketed for a picker, in first-appearance order: per Google
 * account, and per EventKit source for Apple ones (`labelOf` names the
 * bucket, so each platform keeps its own wording).
 */
export const calendarGroups = (
  calendars: ReadonlyArray<CalendarInfo>,
  labelOf: (calendar: CalendarInfo) => string,
): ReadonlyArray<{ readonly calendars: ReadonlyArray<CalendarInfo>; readonly label: string }> =>
  groupsBy(calendars, labelOf).map(({ items, label }) => ({ calendars: items, label }));

/** Task lists bucketed for the task editor's picker, per account, in first-appearance order. */
export const taskListGroups = (
  lists: ReadonlyArray<TaskListInfo>,
  labelOf: (list: TaskListInfo) => string,
): ReadonlyArray<{ readonly label: string; readonly lists: ReadonlyArray<TaskListInfo> }> =>
  groupsBy(lists, labelOf).map(({ items, label }) => ({ label, lists: items }));

const groupsBy = <T>(
  items: ReadonlyArray<T>,
  labelOf: (item: T) => string,
): ReadonlyArray<{ readonly items: ReadonlyArray<T>; readonly label: string }> => {
  const groups = new Map<string, Array<T>>();
  for (const item of items) {
    const label = labelOf(item);
    groups.set(label, [...(groups.get(label) ?? []), item]);
  }
  return [...groups].map(([label, entries]) => ({ items: entries, label }));
};

/**
 * What the editor offers for an event, from the calendar it lives in and
 * the one picked. Guests and RSVPs exist only on Google (EventKit cannot
 * write attendees); an event in a calendar we cannot write opens as a
 * viewer; and moving takes the whole series, so an occurrence-scoped edit
 * keeps its calendar.
 */
export const editorCapabilities = ({
  hasOwnAttendee,
  isExisting,
  isRecurring,
  scope,
  sourceCalendar,
  targetCalendar,
}: {
  readonly hasOwnAttendee: boolean;
  readonly isExisting: boolean;
  readonly isRecurring: boolean;
  readonly scope: RecurringScope;
  readonly sourceCalendar: CalendarInfo | undefined;
  readonly targetCalendar: CalendarInfo | undefined;
}) => {
  const readOnly =
    isExisting && sourceCalendar !== undefined && !isCalendarWritable(sourceCalendar);
  return {
    canInvite: (targetCalendar?.provider ?? 'google') === 'google',
    canMoveCalendar: isExisting && !readOnly && (!isRecurring || scope === 'series'),
    canRsvp: (sourceCalendar?.provider ?? 'google') === 'google' && hasOwnAttendee,
    /** A repeating event keeps its kind (see `recurringTimesError`). */
    canSwitchAllDay: !(isExisting && isRecurring),
    /** "Calendar default" is a Google concept; EventKit alarms are always explicit. */
    canUseDefaultReminders: (targetCalendar?.provider ?? 'google') === 'google',
    readOnly,
  };
};

/**
 * Why a time edit of an existing repeating event cannot be saved, or
 * undefined. A series keeps its kind (timed or all-day), and an all-day
 * one moves one occurrence at a time — the rules EventMutations and the
 * agent gateway enforce, checked here so the editor can say so in words.
 */
export const recurringTimesError = ({
  date,
  endDate,
  isAllDay,
  opened,
  scope,
}: {
  /** The editor's date field now. */
  readonly date: string;
  /** The editor's end date field now. */
  readonly endDate: string;
  readonly isAllDay: boolean;
  /** The occurrence as the editor opened it. */
  readonly opened: { readonly date: string; readonly endDate: string; readonly isAllDay: boolean };
  readonly scope: RecurringScope;
}): string | undefined => {
  if (isAllDay !== opened.isAllDay) {
    return 'A repeating event cannot switch between all-day and timed.';
  }
  // A series write keeps an all-day master's dates (EventMutations), so a
  // new first or last day would be dropped there.
  if (isAllDay && scope !== 'instance' && (date !== opened.date || endDate !== opened.endDate)) {
    return 'An all-day repeating event moves one occurrence at a time: choose “This event”.';
  }
  return undefined;
};

/**
 * A changed rule needs a scope that can hold one: one occurrence cannot
 * repeat on its own (the rule EventMutations enforces, said in words).
 */
export const repeatScopeError = ({
  dirty,
  isRecurring,
  scope,
}: {
  /** The repeat fields were edited since the form opened. */
  readonly dirty: boolean;
  readonly isRecurring: boolean;
  readonly scope: RecurringScope;
}): string | undefined =>
  isRecurring && dirty && scope === 'instance'
    ? 'Choose “All events” or “This and following” to change how it repeats.'
    : undefined;

/**
 * What an editor asks before a write that drops something. The platform
 * words the buttons from `kind` and `subject`: a `move` keeps the item
 * where it is, a `convert` (an existing item changes kind on Save) or a
 * `switch` (a new draft changes kind) keeps it as the `subject`, and a
 * `delete` keeps it — its `summary` is the whole question
 * (`deleteQuestion`, `deleteTaskQuestion`).
 */
export interface EditorConfirmRequest {
  readonly kind: 'convert' | 'delete' | 'move' | 'switch';
  readonly subject: 'event' | 'reminder' | 'task';
  readonly summary: string;
  /** A `switch`: the kind being switched to (the dialog names it). */
  readonly target?: ItemKind | undefined;
}

/**
 * A promise-shaped yes/no for the move and conversion confirmations, for
 * UIs that render them inline (desktop). `request` resolves once `answer`
 * is called.
 */
export const useMoveConfirmation = () => {
  const [pending, setPending] = useState<{
    readonly request: EditorConfirmRequest;
    readonly resolve: (ok: boolean) => void;
  } | null>(null);
  const request = useCallback(
    (question: EditorConfirmRequest) =>
      new Promise<boolean>((resolve) => setPending({ request: question, resolve })),
    [],
  );
  const answer = (ok: boolean) => {
    pending?.resolve(ok);
    setPending(null);
  };
  return { answer, pending: pending?.request ?? null, request };
};

const timeString = (epochMs: number, timeZone: string): string =>
  toZonedDateTime(epochMs, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

/** Days from one form date to another, or undefined while either field is mid-edit. */
const daysFrom = (from: string, until: string): number | undefined => {
  try {
    return daysBetweenPlainDates(from, until);
  } catch {
    return undefined;
  }
};

const shiftDate = (date: string, days: number): string | undefined => {
  try {
    return addDaysToPlainDate(date, days);
  } catch {
    return undefined;
  }
};

/**
 * Whether an update of an existing event sends its times. Untouched ones
 * stay out (`timeFieldsChanged`), so the stored span is kept exactly —
 * except on a this-and-following split, whose new series starts from the
 * times sent: the occurrence as the form shows it, moved or not.
 */
export const updateSendsTimes = ({
  changed,
  isRecurring,
  scope,
}: {
  readonly changed: boolean;
  readonly isRecurring: boolean;
  readonly scope: RecurringScope;
}): boolean => changed || (isRecurring && scope === 'following');

/**
 * Everything the event editors do that isn't JSX: field state, validation,
 * and the create/update/delete/RSVP calls. Desktop and iOS share it so the
 * two UIs can't drift apart in behaviour.
 */
export const useEventEditorModel = ({
  calendars,
  confirm,
  onClose,
  onSaved,
  seed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  /**
   * Asked before a move or conversion that drops something (guests, the
   * meeting link, a task's priority…): the platform shows the summary
   * and resolves whether to go ahead. Writes that lose nothing are not
   * asked about.
   */
  confirm: (request: EditorConfirmRequest) => Promise<boolean>;
  onClose: () => void;
  /**
   * Called when Save went through, right before `onClose` — the only way a
   * caller can tell a saved editor from a dismissed one (capture marks its
   * row as added). Not called for a delete.
   */
  onSaved?: (() => void) | undefined;
  seed: EventEditorSeed;
  timeZone: string;
}) => {
  const mutations = useBackendMutations();
  const accounts = useAccounts();
  const existing = seed.event;
  const isRecurring = Boolean(existing && (existing.recurrence || existing.recurringEventId));
  const ownEmail = accounts
    .find((account) => account.id === existing?.accountId)
    ?.email.toLowerCase();
  const ownAttendee: Attendee | undefined = existing?.attendees?.find(
    (attendee) => attendee.isSelf === true || attendee.email.toLowerCase() === ownEmail,
  );
  const joinUrl = existing ? meetingUrl(existing) : undefined;
  // The series' rule: a master row carries it, an occurrence's arrives by id.
  const master = useEventMaster(existing);
  const writableCalendars = calendars.filter(isCalendarWritable);

  const prefill = seed.prefill;
  const [title, setTitle] = useState(existing?.title ?? prefill?.title ?? '');
  const originalCalendarKey = existing ? `${existing.accountId}:${existing.calendarId}` : undefined;
  const calendarOf = (key: string | undefined) =>
    calendars.find((calendar) => `${calendar.accountId}:${calendar.id}` === key);
  const [calendarKey, setCalendarKey] = useState(() => {
    if (existing) {
      return `${existing.accountId}:${existing.calendarId}`;
    }
    const writableKeys = writableCalendars.map(
      (calendar) => `${calendar.accountId}:${calendar.id}`,
    );
    const preferred = [seed.calendarKey, lastUsedCalendarKey].find(
      (key): key is string => key !== undefined && key !== null && writableKeys.includes(key),
    );
    return preferred ?? writableKeys[0] ?? '';
  });
  const [isAllDay, setIsAllDay] = useState(existing?.isAllDay ?? prefill?.isAllDay ?? false);
  // An existing event's span in days: a multi-day event ends on a later
  // day, an overnight one on the next.
  const openedDates = existing ? editorDatesOf(existing, timeZone) : undefined;
  const openedDate = openedDates?.date;
  const [date, setDate] = useState(openedDate ?? prefill?.date ?? seed.initialDate.toString());
  const [endDate, setEndDate] = useState(
    openedDates?.endDate ?? prefill?.endDate ?? prefill?.date ?? seed.initialDate.toString(),
  );
  const [startTime, setStartTime] = useState(
    existing && !existing.isAllDay
      ? timeString(existing.startUtc, timeZone)
      : seedTimeFields(seed).startTime,
  );
  const [endTime, setEndTime] = useState(
    existing && !existing.isAllDay
      ? timeString(existing.endUtc, timeZone)
      : seedTimeFields(seed).endTime,
  );
  // The time fields as the form opened (`timeFieldsChanged`).
  const [openedTimes] = useState(() => ({ date, endDate, endTime, isAllDay, startTime }));
  // How many days the end follows the start, as last seen whole: a start
  // field cleared mid-edit (desktop) still carries the end to the next date.
  const spanDays = useRef(daysFrom(date, endDate) ?? 0);
  /** A new start day: the end day moves with it, so the event keeps its length. */
  const moveDate = (next: string) => {
    const span = daysFrom(date, endDate) ?? spanDays.current;
    spanDays.current = span;
    const moved = shiftDate(next, span);
    if (moved !== undefined) {
      setEndDate(moved);
    }
    setDate(next);
  };
  const changeEndDate = (next: string) => {
    const span = daysFrom(date, next);
    if (span !== undefined) {
      spanDays.current = span;
    }
    setEndDate(next);
  };
  // A stored event, a drawn slot or a parsed phrase chose the time; the
  // clicked hour and the 09:00 fallback are the editor's own defaults.
  // Only a chosen time follows the draft into a task.
  const [timeChosen, setTimeChosen] = useState(
    existing !== undefined || seed.initialTimes !== undefined || prefill !== undefined,
  );
  // A phrase's meal or part-of-day word set the times, not a clock time it
  // stated: the form says so until the times are set by hand or by a slot.
  const [assumedTime, setAssumedTime] = useState(prefill?.assumedTime === true);
  const [location, setLocation] = useState(existing?.location ?? prefill?.location ?? '');
  // The text the editor opened with, or a parsed phrase set (see
  // `applyPrefill`): the one text that is looked up without a pick.
  const [givenLocation, setGivenLocation] = useState(location);
  // The text kept as said (`keepLocationText`): no place for it, none
  // looked up, until the field reads something else.
  const [asSaid, setAsSaid] = useState('');
  // Coordinates for the location text, from the event (server-mirrored) or
  // a picked suggestion. Never cleared on typing: they count only while
  // geoMatches, so retyping the original text brings the map back.
  const [geo, setGeo] = useState<GeoLocation | undefined>(existing?.geo);
  const [picking, setPicking] = useState(false);
  // Text the editor was given and has no coordinates for (an event from
  // before this feature, another client's edit, a quick-add location):
  // geocoded once. Typing never geocodes — the picker does that — so an
  // edit away from the given text stops the lookup.
  const lookupLocation = locationToLookUp({ asSaid, geo, given: givenLocation, location });
  const lookup = useLocationGeo(lookupLocation);
  const mapGeo = geoMatches(geo, location)
    ? geo
    : lookupLocation !== '' && geoMatches(lookup.geo ?? undefined, location)
      ? (lookup.geo ?? undefined)
      : undefined;
  const mapLoading = picking || (lookupLocation !== '' && lookup.loading);
  // The guest list as the editor shows it; `attendeesDirty` keeps an
  // untouched list out of the update (undefined = unchanged upstream).
  const [attendees, setAttendees] = useState<ReadonlyArray<AttendeeInput>>(() =>
    (existing?.attendees ?? [])
      // Rooms are not guests: hidden here, carried over by mergeAttendees.
      .filter((attendee) => !attendee.isResource)
      .map((attendee) => ({ displayName: attendee.displayName, email: attendee.email })),
  );
  const [attendeesDirty, setAttendeesDirty] = useState(false);
  // Reminders as the editor shows them. A Google event without the field
  // (synced before reminders were modelled) defers to its calendar; an
  // Apple one never can. `remindersDirty` keeps an untouched value out of
  // the update, like the guest list.
  const [reminders, setReminders] = useState<EventReminders>(
    () =>
      existing?.reminders ??
      new EventReminders({
        overrides: [],
        useDefault: calendarOf(originalCalendarKey ?? calendarKey)?.provider !== 'apple',
      }),
  );
  const [remindersDirty, setRemindersDirty] = useState(false);
  const [scope, setScopeState] = useState<RecurringScope>(seed.initialScope ?? 'instance');
  const capabilities = editorCapabilities({
    hasOwnAttendee: ownAttendee !== undefined,
    isExisting: existing !== undefined,
    isRecurring,
    scope,
    sourceCalendar: calendarOf(originalCalendarKey),
    targetCalendar: calendarOf(calendarKey),
  });
  /** An occurrence-scoped edit cannot move: the series moves as a whole. */
  const setScope = (next: RecurringScope) => {
    setScopeState(next);
    if (next !== 'series' && originalCalendarKey) {
      setCalendarKey(originalCalendarKey);
    }
  };
  /** The popup offsets the picked calendar's default resolves to (Google only). */
  const calendarDefaultReminders: ReadonlyArray<number> = (
    calendarOf(calendarKey)?.defaultReminders ?? []
  )
    .filter((override) => override.method === 'popup')
    .map((override) => override.minutes);
  /**
   * What the picked calendar will actually get. An Apple calendar cannot
   * hold "calendar default", so a deferring event shows the popup
   * defaults of the calendar it came from as explicit alarms — the same
   * resolution a move applies — without touching the stored value until
   * the user edits a row or saves onto that calendar.
   */
  const resolvedReminders: EventReminders =
    reminders.useDefault && !capabilities.canUseDefaultReminders
      ? new EventReminders({
          overrides: (calendarOf(originalCalendarKey)?.defaultReminders ?? []).filter(
            (override) => override.method === 'popup',
          ),
          useDefault: false,
        })
      : reminders;
  const updateReminders = (next: EventReminders) => {
    setReminders(canonicalReminders(next));
    setRemindersDirty(true);
  };
  const setUseDefaultReminders = (useDefault: boolean) =>
    updateReminders(new EventReminders({ ...reminders, useDefault }));
  /** Adds a popup reminder; false (and no change) when it is already there or at Google's maximum. */
  const addReminder = (minutes: number): boolean => {
    const current = resolvedReminders.overrides;
    if (
      current.length >= MAX_REMINDER_OVERRIDES ||
      current.some((override) => override.method === 'popup' && override.minutes === minutes)
    ) {
      return false;
    }
    updateReminders(
      new EventReminders({
        overrides: [...current, new ReminderOverride({ method: 'popup', minutes })],
        useDefault: false,
      }),
    );
    return true;
  };
  const setReminderMinutes = (index: number, minutes: number) =>
    updateReminders(
      new EventReminders({
        overrides: resolvedReminders.overrides.map((override, at) =>
          at === index ? new ReminderOverride({ method: override.method, minutes }) : override,
        ),
        useDefault: false,
      }),
    );
  const removeReminder = (index: number) =>
    updateReminders(
      new EventReminders({
        overrides: resolvedReminders.overrides.filter((_, at) => at !== index),
        useDefault: false,
      }),
    );
  // The user's reply as last chosen here. It follows the record's reply
  // whenever that changes: the refresh after this view's own answer, or
  // an answer given elsewhere while a view of the live record (the
  // desktop inspector) stays open.
  const storedRsvp = ownAttendee?.responseStatus;
  const [rsvp, setRsvp] = useState(storedRsvp);
  const [rsvpSeen, setRsvpSeen] = useState(storedRsvp);
  if (storedRsvp !== rsvpSeen) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setRsvpSeen(storedRsvp);
    setRsvp(storedRsvp);
  }
  const [description, setDescription] = useState(existing?.description ?? '');
  // The text and coordinates as the form opened: an update sends only what
  // differs from them (`eventEditorChanges`) — captured once, never re-read
  // from the record, so an edit made elsewhere meanwhile survives a Save
  // that did not touch it.
  const [openedText] = useState<EventEditorText>(() => ({
    description: description.trim(),
    geo,
    location: location.trim(),
    title: title.trim(),
  }));
  // An existing series seeds the repeat form from its master's lines once
  // they are here (keyed, so the form re-seeds when they land); a new
  // event from the quick-add prefill.
  const masterLines = existing ? master.recurrence : undefined;
  const { toSpec: repeatSpec, ...repeatState } = useRepeatState(
    existing
      ? taskRecurrenceFromLines(masterLines, { isAllDay: existing.isAllDay, startTime, timeZone })
      : prefill?.recurrence,
    date,
    existing ? (masterLines?.join('\n') ?? '') : undefined,
  );
  // An untouched rule is never re-sent: only an edit puts `recurrence` on the update.
  const [repeatDirty, setRepeatDirty] = useState(false);
  const marking =
    <A extends ReadonlyArray<unknown>>(set: (...args: A) => void) =>
    (...args: A) => {
      setRepeatDirty(true);
      set(...args);
    };
  // The URL a task carried in: the form has no control for it, so it goes
  // out with the create draft as it came.
  const [carried, setCarried] = useState<{ readonly url?: string | undefined }>({});
  const [error, setError] = useState<string | null>(null);
  const write = useOneWrite();

  /** The form as a conversion source (see core `convert.ts`). */
  const values = (): EventConvertValues => {
    const spec = repeatSpec();
    return {
      attendees,
      date,
      defaultReminderMinutes: calendarDefaultReminders,
      description: description.trim() || undefined,
      endTime,
      hangoutLink: existing?.hangoutLink,
      isAllDay,
      location: location.trim() || undefined,
      // An occurrence never carries its series' lines; the backend preview does.
      recurrence: existing
        ? existing.recurrence
        : spec
          ? [buildRecurrenceRule(spec, isAllDay, timeZone)]
          : undefined,
      reminders,
      startTime,
      startTimeZone: existing?.startTimeZone ?? timeZone,
      timeChosen,
      title: title.trim(),
      url: carried.url,
    };
  };

  /** Takes a task's fields over (a create-mode flip or a conversion); guests and location stay. */
  const adopt = (next: EventConvertValues) => {
    setTitle(next.title);
    setIsAllDay(next.isAllDay);
    setDate(next.date);
    // A task has one day.
    setEndDate(next.date);
    spanDays.current = 0;
    setStartTime(next.startTime);
    setEndTime(next.endTime);
    setTimeChosen(next.timeChosen);
    setAssumedTime(false);
    updateReminders(next.reminders);
    // A task's rule comes as the form holds it; lines are parsed back only
    // when that is all there is.
    repeatState.resetRepeat(
      next.repeat ??
        taskRecurrenceFromLines(next.recurrence, {
          isAllDay: next.isAllDay,
          startTime: next.startTime,
          timeZone,
        }),
    );
    setDescription(next.description ?? '');
    setCarried({ url: next.url });
  };

  /**
   * A free slot the finder found: the event moves to its day and times.
   * An all-day series keeps its kind (`canSwitchAllDay`), so a slot
   * cannot make it timed; the forms hide the finder there.
   */
  const applySlot = (slot: FreeSlot) => {
    if (isAllDay && !capabilities.canSwitchAllDay) {
      return;
    }
    setIsAllDay(false);
    setDate(slot.date);
    setEndDate(slot.date);
    spanDays.current = 0;
    setStartTime(slot.startTime);
    setEndTime(slot.endTime);
    setTimeChosen(true);
    setAssumedTime(false);
    setError(null);
  };

  /**
   * What the form holds beyond the prefill — guests, notes, notifications
   * (as edited, else undefined) — for a thread to keep with its draft.
   */
  const extras = () => ({
    attendees,
    description,
    // The picked coordinates, while they still match the text (`geoMatches`).
    geo: geoMatches(geo, location.trim()) ? geo : undefined,
    locationAsSaid: keptAsSaid(asSaid, location) ? location : undefined,
    reminders: remindersDirty ? reminders : undefined,
  });

  /**
   * Another draft's extras take the form over (undefined: a draft the form
   * never held, which starts clean), so nothing typed for one draft shows
   * on the next — its calendar too, while it can still take events; a
   * draft never given one keeps the form's.
   */
  const restoreExtras = (
    next:
      | {
          readonly attendees: ReadonlyArray<AttendeeInput>;
          readonly calendarKey?: string | undefined;
          readonly description: string;
          readonly geo?: GeoLocation | undefined;
          readonly locationAsSaid?: string | undefined;
          readonly reminders: EventReminders | undefined;
        }
      | undefined,
  ) => {
    const restored = writableCalendarKey(calendars, next?.calendarKey, calendarKey);
    setCalendarKey(restored);
    setAttendees(next?.attendees ?? []);
    setAttendeesDirty((next?.attendees.length ?? 0) > 0);
    setDescription(next?.description ?? '');
    setGeo(next?.geo);
    setAsSaid(next?.locationAsSaid ?? '');
    if (next?.reminders) {
      updateReminders(next.reminders);
    } else {
      setReminders(
        new EventReminders({
          overrides: [],
          useDefault: calendarOf(restored)?.provider !== 'apple',
        }),
      );
      setRemindersDirty(false);
    }
  };

  /**
   * The form as a prefill: what a thread keeps of the focused draft, and
   * what a refinement starts from. The repeat fields come back as a seed
   * (weekdays included), so a draft round-trips through the form whole.
   */
  const toPrefill = (): EventEditorPrefill => {
    const spec = repeatSpec();
    return {
      ...(assumedTime ? { assumedTime: true } : {}),
      date,
      ...(endDate === date ? {} : { endDate }),
      endTime,
      isAllDay,
      ...(location.trim() ? { location: location.trim() } : {}),
      ...(spec
        ? {
            recurrence: {
              ...(spec.byDay ? { byDay: spec.byDay } : {}),
              ...(spec.count !== undefined ? { count: spec.count } : {}),
              freq: spec.freq,
              ...(spec.interval !== undefined ? { interval: spec.interval } : {}),
              ...(spec.untilDate ? { untilDate: spec.untilDate } : {}),
            },
          }
        : {}),
      startTime,
      title: title.trim(),
    };
  };

  /**
   * Takes a parsed phrase over the fields a phrase can say: the title,
   * the day, the times or all-day, the location and the repeat rule —
   * all of them, since the phrase is the whole understanding (a phrase
   * without a place clears one typed before). The calendar, guests,
   * notes and notifications are not a phrase's to change.
   */
  const applyPrefill = (next: EventEditorPrefill) => {
    setTitle(next.title);
    setIsAllDay(next.isAllDay);
    setDate(next.date);
    setEndDate(next.endDate ?? next.date);
    spanDays.current = daysFrom(next.date, next.endDate ?? next.date) ?? 0;
    setStartTime(next.startTime);
    setEndTime(next.endTime);
    setTimeChosen(true);
    setAssumedTime(next.assumedTime === true);
    setLocation(next.location ?? '');
    setGivenLocation(next.location ?? '');
    setRepeatDirty(true);
    repeatState.resetRepeat(next.recurrence);
    setError(null);
  };

  const addAttendee = (input: AttendeeInput): boolean => {
    const key = emailKey(input.email);
    if (key === '' || attendees.some((attendee) => emailKey(attendee.email) === key)) {
      return false;
    }
    setAttendees([...attendees, { displayName: input.displayName, email: input.email.trim() }]);
    setAttendeesDirty(true);
    return true;
  };

  const removeAttendee = (email: string) => {
    const key = emailKey(email);
    setAttendees(attendees.filter((attendee) => emailKey(attendee.email) !== key));
    setAttendeesDirty(true);
  };

  // The last word on the place: a pick's late answer counts only while
  // no chip or "As said" spoke after it.
  const placeWord = useRef(latestWord()).current;
  /**
   * A typeahead row was picked: its label becomes the location text and
   * MapKit resolves that exact place. A slow answer for an older pick is
   * harmless — coordinates only count while they match the current text —
   * unless "As said" put that very text back meanwhile: then it is dropped.
   */
  const pickPlace = async (suggestion: PlaceSuggestion) => {
    const label = placeSuggestionLabel(suggestion);
    const word = placeWord.speak();
    setLocation(label);
    setPicking(true);
    try {
      const resolved = await mutations.resolveLocation({ location: label, suggestion });
      if (resolved && placeWord.stands(word)) {
        setGeo(resolved);
      }
    } catch {
      // No coordinates: the text is still a perfectly good location.
    } finally {
      setPicking(false);
    }
  };

  /**
   * A place picked among a turn's candidates, coordinates in hand: its
   * text becomes the location and its pin counts as a pick (`source`
   * is that text), so Save sends the coordinates.
   */
  const applyPlace = (place: GeoLocation) => {
    placeWord.speak();
    setLocation(place.source);
    setGivenLocation(place.source);
    setAsSaid('');
    setGeo(place);
  };

  /**
   * The location text as said, no place for it: the pin a taken or
   * picked place left goes (a past place with that very text would
   * otherwise keep it), and the text is not looked up — now, or when a
   * turn or a draft switch gives it to the form again (`asSaid` travels
   * in the extras).
   */
  const keepLocationText = (text: string) => {
    placeWord.speak();
    setLocation(text);
    setAsSaid(text);
    setGeo(undefined);
  };

  /** Server facts for a chip (response, organizer) — only for guests already on the event. */
  const attendeeStatus = (email: string): Attendee | undefined =>
    existing?.attendees?.find((attendee) => emailKey(attendee.email) === emailKey(email));

  const save = async () => {
    const fields = { calendarKey, date, endDate, endTime, isAllDay, startTime, title };
    const spec = repeatSpec();
    const invalid =
      validateEventDraft(fields, timeZone) ??
      // The rule is checked when it is being written: a new event's, or an
      // edited one. An untouched series rule is not re-sent, and its UNTIL
      // must not pin an occurrence that is being moved past the series end.
      (spec && (!existing || repeatDirty)
        ? (byDayError(spec) ?? repeatUntilError(spec, date))
        : undefined) ??
      (existing && isRecurring && openedDate !== undefined
        ? recurringTimesError({
            date,
            endDate,
            isAllDay,
            opened: { date: openedDate, endDate: openedTimes.endDate, isAllDay: existing.isAllDay },
            scope,
          })
        : undefined) ??
      repeatScopeError({
        dirty: repeatDirty,
        isRecurring: existing !== undefined && isRecurring,
        scope,
      });
    if (invalid) {
      setError(invalid);
      return;
    }
    // Edits land where the event lives now; a move (below) follows them.
    const [accountId, calendarId] = (originalCalendarKey ?? calendarKey).split(':', 2) as [
      string,
      string,
    ];
    const moveTarget =
      existing && calendarKey !== originalCalendarKey && capabilities.canMoveCalendar
        ? (calendarKey.split(':', 2) as [string, string])
        : undefined;
    const built = buildEventTimes(fields, timeZone);
    try {
      const move =
        existing && moveTarget
          ? {
              accountId,
              calendarId,
              // A series moves as a whole: its master.
              eventId: existing.recurringEventId ?? existing.id,
              target: { accountId: moveTarget[0], calendarId: moveTarget[1] },
            }
          : undefined;
      if (move) {
        // Ask before writing anything, so "keep it here" leaves no trace.
        const loss = await mutations.previewMove(move);
        const summary = moveLossSummary(loss);
        if (
          isLossy(loss) &&
          summary &&
          !(await confirm({ kind: 'move', subject: 'event', summary }))
        ) {
          return;
        }
      }
      if (existing) {
        const masterId = isRecurring ? existing.recurringEventId : undefined;
        const changes = eventEditorChanges({
          attendees: attendeesDirty ? attendees : undefined,
          current: {
            description: description.trim(),
            geo,
            location: location.trim(),
            title: title.trim(),
          },
          initial: openedText,
          // The rule only when edited: lines for a new one, null for "does not repeat".
          recurrence:
            masterId && repeatDirty
              ? spec
                ? [buildRecurrenceRule(spec, isAllDay, timeZone)]
                : null
              : undefined,
          reminders: remindersDirty ? reminders : undefined,
          // A title-only edit must not rebuild the span: untouched times
          // stay out of an update, and the stored ones are kept as they are.
          times: updateSendsTimes({
            changed: timeFieldsChanged(fields, openedTimes),
            isRecurring,
            scope,
          })
            ? { ...built, isAllDay }
            : undefined,
        });
        // An untouched Save writes nothing; a move (below) still runs.
        const edited = Object.keys(changes).length > 0;
        if (edited && masterId) {
          await mutations.updateRecurring({
            accountId,
            calendarId,
            changes,
            masterId,
            originalStartUtc: existing.originalStartUtc ?? existing.startUtc,
            scope,
          });
        } else if (edited) {
          await mutations.updateEvent({ accountId, calendarId, changes, eventId: existing.id });
        }
      } else {
        // A carried URL is the event's on Apple; on Google it rides in the description.
        const targetProvider = calendarOf(calendarKey)?.provider ?? 'google';
        const draftDescription =
          targetProvider === 'google'
            ? appendLink(description.trim() || undefined, carried.url)
            : description.trim() || undefined;
        const draft: EventDraft = {
          accountId,
          // Guests typed before switching to a calendar that cannot invite are not sent.
          ...(attendees.length > 0 && capabilities.canInvite ? { attendees } : {}),
          calendarId,
          ...(draftDescription ? { description: draftDescription } : {}),
          // Only coordinates the user vouched for reach Google.
          geo: vouchedGeo(geo, location.trim()),
          isAllDay,
          location: location.trim() || undefined,
          recurrence: (() => {
            // The draft's startTimeZone (buildEventTimes): its UNTIL ends there.
            return spec ? [buildRecurrenceRule(spec, isAllDay, timeZone)] : undefined;
          })(),
          // Untouched on a Google calendar means Google's own default; an
          // Apple calendar always gets the explicit (resolved) list.
          ...(remindersDirty || !capabilities.canUseDefaultReminders
            ? { reminders: resolvedReminders }
            : {}),
          title: title.trim(),
          ...built,
          ...(targetProvider === 'apple' && carried.url ? { url: carried.url } : {}),
        };
        const task = seed.convertFromTask;
        if (task) {
          // The backend knows the task's subtasks, which its delete takes along.
          const loss = await mutations.previewTaskToEvent({
            accountId: task.accountId,
            taskId: task.id,
            taskListId: task.listId,
          });
          const summary = taskToEventLossSummary(loss, 'Converting this task to an event');
          // Ask before writing anything, so "keep it a task" leaves no trace.
          if (
            isTaskToEventLossy(loss) &&
            summary &&
            !(await confirm({ kind: 'convert', subject: 'task', summary }))
          ) {
            return;
          }
          await mutations.convertTaskToEvent({
            accountId: task.accountId,
            draft,
            taskId: task.id,
            taskListId: task.listId,
          });
        } else {
          await mutations.createEvent(draft);
        }
        rememberCalendar(calendarKey);
      }
      if (move) {
        // Update, then move: the move carries the saved fields along.
        await mutations.moveEvent(move);
      }
      onSaved?.();
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  const respond = async (response: RsvpResponse) => {
    if (!existing) {
      return;
    }
    setRsvp(response);
    try {
      // RSVP applies to the whole series when opened from an instance.
      await mutations.respondToEvent({
        accountId: existing.accountId,
        calendarId: existing.calendarId,
        eventId: existing.recurringEventId ?? existing.id,
        response,
      });
    } catch (error) {
      setError(String(error));
    }
  };

  const remove = async () => {
    if (!existing) {
      return;
    }
    const series = isRecurring && existing.recurringEventId !== undefined;
    if (
      !(await confirm({
        kind: 'delete',
        subject: 'event',
        summary: deleteQuestion(existing.title, series ? scope : undefined),
      }))
    ) {
      return;
    }
    try {
      if (isRecurring && existing.recurringEventId) {
        await mutations.deleteRecurring({
          accountId: existing.accountId,
          calendarId: existing.calendarId,
          masterId: existing.recurringEventId,
          originalStartUtc: existing.originalStartUtc ?? existing.startUtc,
          scope,
        });
      } else {
        await mutations.deleteEvent({
          accountId: existing.accountId,
          calendarId: existing.calendarId,
          eventId: existing.id,
        });
      }
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  return {
    addAttendee,
    addReminder,
    adopt,
    applyPlace,
    applyPrefill,
    applySlot,
    /** The times came from a phrase's meal or part-of-day word and have not been set since. */
    assumedTime,
    attendees,
    attendeeStatus,
    /** A save or delete is running: Save and Delete are dimmed (a press does nothing). */
    busy: write.busy,
    /** Popup offsets "calendar default" stands for on the picked calendar. */
    calendarDefaultReminders,
    calendarKey,
    ...capabilities,
    date,
    description,
    /** The form's span in minutes, for the finder's starting duration (an hour for all-day). */
    durationMinutes: isAllDay
      ? 60
      : draftMinutes({ date, endDate, endTime, isAllDay, startTime }, timeZone),
    endDate,
    endTime,
    error,
    existing,
    /** Guests, notes and edited notifications, for a thread to keep with its draft. */
    extras,
    isAllDay,
    isRecurring,
    joinUrl,
    keepLocationText,
    location,
    /** Coordinates to map for the current text, if known. */
    mapGeo,
    mapLoading,
    /** An existing series' master, once here: its first start and its lines (the finder's exclusion reads them). */
    masterSeries:
      existing?.recurringEventId !== undefined && master.loaded
        ? { recurrence: master.recurrence, startUtc: master.startUtc }
        : undefined,
    /** Apple Maps link for the mapped place (https: routes to Maps on macOS and iOS). */
    mapsUrl: mapGeo ? openInMapsUrl(mapGeo) : undefined,
    ownAttendee,
    pickPlace,
    reminders: resolvedReminders,
    remove: () => write.run(remove),
    removeAttendee,
    removeReminder,
    ...repeatState,
    /** The repeat form was edited since it opened: Save sends the rule. */
    repeatDirty,
    /**
     * The repeat fields can show: a new event right away, an existing
     * series once its master's lines are here (never for a read-through
     * Apple series, whose rule the app does not hold).
     */
    repeatLoaded: existing === undefined || (isRecurring && master.loaded),
    respond,
    restoreExtras,
    rsvp,
    save: () => write.run(save),
    scope,
    setCalendarKey,
    setDate: moveDate,
    setDescription,
    setEndDate: changeEndDate,
    setEndTime: (time: string) => {
      setEndTime(time);
      setTimeChosen(true);
      setAssumedTime(false);
    },
    setIsAllDay: (allDay: boolean) => {
      setIsAllDay(allDay);
      setTimeChosen(true);
      setAssumedTime(false);
    },
    setLocation,
    setReminderMinutes,
    setRepeat: marking(repeatState.setRepeat),
    setRepeatCount: marking(repeatState.setRepeatCount),
    setRepeatEnds: marking(repeatState.setRepeatEnds),
    setRepeatInterval: marking(repeatState.setRepeatInterval),
    setRepeatMonthly: marking(repeatState.setRepeatMonthly),
    setRepeatOrdinal: marking(repeatState.setRepeatOrdinal),
    setRepeatOrdinalWeekday: marking(repeatState.setRepeatOrdinalWeekday),
    setRepeatUntil: marking(repeatState.setRepeatUntil),
    setScope,
    setStartTime: (time: string) => {
      setStartTime(time);
      setTimeChosen(true);
      setAssumedTime(false);
    },
    setTitle,
    setUseDefaultReminders,
    startTime,
    /** The picked calendar's provider: what a create (or conversion) writes to. */
    targetProvider: calendarOf(calendarKey)?.provider ?? 'google',
    /** The primary zone the date/time fields are wall clock in. */
    timeZone,
    title,
    toggleWeekday: marking(repeatState.toggleWeekday),
    toPrefill,
    values,
    writableCalendars,
  };
};
