import {
  appendLink,
  byDayError,
  repeatUntilError,
  isCalendarWritable,
  isLossy,
  isTaskToEventLossy,
  moveLossSummary,
  taskRecurrenceFromLines,
  taskToEventLoss,
  taskToEventLossSummary,
  buildRecurrenceRule,
  buildEventTimes,
  canonicalReminders,
  emailKey,
  geoMatches,
  isMappableLocation,
  meetingUrl,
  openInMapsUrl,
  placeSuggestionLabel,
  slotTimes,
  toZonedDateTime,
  validateEventDraft,
  type Attendee,
  type AttendeeInput,
  type CalendarInfo,
  type EventConvertValues,
  type EventDraft,
  type EventRecord,
  EventReminders,
  type FreeSlot,
  GeoLocation,
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
import { useCallback, useState } from 'react';
import { deleteQuestion } from './deleteQuestion.ts';
import { useAccounts, useBackendMutations, useEventMaster, useLocationGeo } from './hooks.ts';
import { useOneWrite } from './oneWrite.ts';
import { useRepeatState } from './repeatState.ts';

/**
 * Fields a parsed phrase can prefill. Structural on purpose so app-state
 * stays independent of the AI package.
 */
export type { RepeatEnds } from './repeatState.ts';

export interface EventEditorPrefill {
  readonly date: string;
  readonly endTime: string;
  readonly isAllDay: boolean;
  readonly location?: string;
  readonly recurrence?: {
    readonly count?: number;
    readonly freq: RecurrenceFrequency;
    readonly interval?: number;
    readonly untilDate?: string;
  };
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
  isAllDay,
  opened,
  scope,
}: {
  /** The editor's date field now. */
  readonly date: string;
  readonly isAllDay: boolean;
  /** The occurrence as the editor opened it. */
  readonly opened: { readonly date: string; readonly isAllDay: boolean };
  readonly scope: RecurringScope;
}): string | undefined => {
  if (isAllDay !== opened.isAllDay) {
    return 'A repeating event cannot switch between all-day and timed.';
  }
  if (isAllDay && scope !== 'instance' && date !== opened.date) {
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
 * (`deleteQuestion`).
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
  const openedDate = existing
    ? (existing.startDate ?? toZonedDateTime(existing.startUtc, timeZone).toPlainDate().toString())
    : undefined;
  const [date, setDate] = useState(openedDate ?? prefill?.date ?? seed.initialDate.toString());
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
  // A stored event, a drawn slot or a parsed phrase chose the time; the
  // clicked hour and the 09:00 fallback are the editor's own defaults.
  // Only a chosen time follows the draft into a task.
  const [timeChosen, setTimeChosen] = useState(
    existing !== undefined || seed.initialTimes !== undefined || prefill !== undefined,
  );
  const [location, setLocation] = useState(existing?.location ?? prefill?.location ?? '');
  // The text the editor opened with, or a parsed phrase set (see
  // `applyPrefill`): the one text that is looked up without a pick.
  const [givenLocation, setGivenLocation] = useState(location);
  // Coordinates for the location text, from the event (server-mirrored) or
  // a picked suggestion. Never cleared on typing: they count only while
  // geoMatches, so retyping the original text brings the map back.
  const [geo, setGeo] = useState<GeoLocation | undefined>(existing?.geo);
  const [picking, setPicking] = useState(false);
  // Text the editor was given and has no coordinates for (an event from
  // before this feature, another client's edit, a quick-add location):
  // geocoded once. Typing never geocodes — the picker does that — so an
  // edit away from the given text stops the lookup.
  const lookupLocation =
    location === givenLocation && !geoMatches(geo, location) && isMappableLocation(location)
      ? location
      : '';
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
    setStartTime(next.startTime);
    setEndTime(next.endTime);
    setTimeChosen(next.timeChosen);
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
    setStartTime(slot.startTime);
    setEndTime(slot.endTime);
    setTimeChosen(true);
    setError(null);
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
    setStartTime(next.startTime);
    setEndTime(next.endTime);
    setTimeChosen(true);
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

  /**
   * A typeahead row was picked: its label becomes the location text and
   * MapKit resolves that exact place. A slow answer for an older pick is
   * harmless — coordinates only count while they match the current text.
   */
  const pickPlace = async (suggestion: PlaceSuggestion) => {
    const label = placeSuggestionLabel(suggestion);
    setLocation(label);
    setPicking(true);
    try {
      const resolved = await mutations.resolveLocation({ location: label, suggestion });
      if (resolved) {
        setGeo(resolved);
      }
    } catch {
      // No coordinates: the text is still a perfectly good location.
    } finally {
      setPicking(false);
    }
  };

  /** Server facts for a chip (response, organizer) — only for guests already on the event. */
  const attendeeStatus = (email: string): Attendee | undefined =>
    existing?.attendees?.find((attendee) => emailKey(attendee.email) === emailKey(email));

  const save = async () => {
    const fields = { calendarKey, date, endTime, isAllDay, startTime, title };
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
            isAllDay,
            opened: { date: openedDate, isAllDay: existing.isAllDay },
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
    const times = buildEventTimes(fields, timeZone);
    // Only coordinates the user vouched for reach Google: the event's own
    // (mirrored) ones or a picked suggestion, and only while they match the
    // text being saved. The open-time lookup of free text stays on this
    // device — MapKit's guess for "Room 4B" must not become every device's
    // truth. An update sends null so stale ones are cleared.
    const savedGeo = geoMatches(geo, location.trim())
      ? new GeoLocation({ ...geo, source: location.trim() })
      : undefined;
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
      if (existing && isRecurring && existing.recurringEventId) {
        await mutations.updateRecurring({
          accountId,
          calendarId,
          changes: {
            ...(attendeesDirty ? { attendees } : {}),
            description: description.trim(),
            geo: savedGeo ?? null,
            // Sent so the times are read as what they are: a switch is
            // refused above, and by the mutation should one get past.
            isAllDay,
            // Empty string clears the field; undefined would read as "unchanged".
            location: location.trim(),
            // The rule only when edited: lines for a new one, null for "does not repeat".
            ...(repeatDirty
              ? { recurrence: spec ? [buildRecurrenceRule(spec, isAllDay, timeZone)] : null }
              : {}),
            ...(remindersDirty ? { reminders } : {}),
            title: title.trim(),
            ...times,
          },
          masterId: existing.recurringEventId,
          originalStartUtc: existing.originalStartUtc ?? existing.startUtc,
          scope,
        });
      } else if (existing) {
        await mutations.updateEvent({
          accountId,
          calendarId,
          changes: {
            ...(attendeesDirty ? { attendees } : {}),
            description: description.trim(),
            geo: savedGeo ?? null,
            isAllDay,
            location: location.trim(),
            ...(remindersDirty ? { reminders } : {}),
            title: title.trim(),
            ...times,
          },
          eventId: existing.id,
        });
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
          geo: savedGeo,
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
          ...times,
          ...(targetProvider === 'apple' && carried.url ? { url: carried.url } : {}),
        };
        const task = seed.convertFromTask;
        if (task) {
          const loss = taskToEventLoss(task);
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
    applyPrefill,
    applySlot,
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
    endTime,
    error,
    existing,
    isAllDay,
    isRecurring,
    joinUrl,
    location,
    /** Coordinates to map for the current text, if known. */
    mapGeo,
    /** An existing series' first start, once its master is here (the finder's exclusion reads it). */
    mapLoading,
    masterStartUtc: existing?.recurringEventId !== undefined ? master.startUtc : undefined,
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
    rsvp,
    save: () => write.run(save),
    scope,
    setCalendarKey,
    setDate,
    setDescription,
    setEndTime: (time: string) => {
      setEndTime(time);
      setTimeChosen(true);
    },
    setIsAllDay: (allDay: boolean) => {
      setIsAllDay(allDay);
      setTimeChosen(true);
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
    values,
    writableCalendars,
  };
};
