import type { QuickAddTaskPrefill } from '@calendar/ai';
import {
  appendLink,
  byDayError,
  type CalendarInfo,
  type EventDraft,
  repeatUntilError,
  type TaskDraft,
  type TaskListInfo,
  taskListKeyOf,
  type TaskProvider,
} from '@calendar/core';
import { eventDraftFromPrefill, prefillError } from './draftPreview.ts';
import type { Draft, DraftExtras, DraftThreadState } from './draftThread.ts';
import { writableCalendarKey } from './editorModel.ts';
import { type RepeatFields, repeatNumberError, repeatSpecFrom } from './repeatState.ts';
import { offeredTaskLists } from './taskEditorChanges.ts';

/**
 * "Add all": every draft beside the focused one written as it stands —
 * an event into its calendar, a to-do into its list, each the one the
 * form had picked while it showed the draft (one never shown goes where
 * the form points now) — after Save's own checks, so a draft Save would
 * refuse stops the batch before anything is written. The focused draft
 * is not here: it goes through its form.
 */

/** Where the form points now: what a draft never given a calendar or list takes. */
export interface DraftDefaults {
  readonly calendarKey: string;
  readonly listKey: string;
}

/** The calendar an event draft goes to: the one it was given, while it still takes events, else the form's. */
export const draftCalendarKey = (
  draft: Draft,
  calendars: ReadonlyArray<CalendarInfo>,
  fallback: string,
): string => writableCalendarKey(calendars, draft.extras?.calendarKey, fallback);

/** Whether a new to-do can go to the list: it is here and writable. */
const takesTodos = (taskLists: ReadonlyArray<TaskListInfo>, key: string): boolean =>
  offeredTaskLists(taskLists, undefined).some((list) => taskListKeyOf(list) === key);

/** The list a to-do draft goes to: the one it was given, while it still takes to-dos, else the form's. */
export const draftListKey = (
  draft: Draft,
  taskLists: ReadonlyArray<TaskListInfo>,
  fallback: string,
): string => {
  const key = draft.extras?.listKey;
  return key !== undefined && takesTodos(taskLists, key) ? key : fallback;
};

/** A to-do as `createTask` takes it: a draft's fields on a list, no due day for an undated one. */
export type NewTask = Omit<TaskDraft, 'dueDate'> & {
  readonly accountId: string;
  readonly dueDate?: string;
  readonly taskListId: string;
};

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** Save's checks of a reminder's repeat fields, numbers as typed, from its first day. */
const repeatError = (fields: RepeatFields, date: string): string | undefined => {
  const spec = repeatSpecFrom(fields, date);
  return spec === undefined
    ? undefined
    : (repeatNumberError(fields.interval, 'The repeat interval') ??
        (fields.ends === 'after'
          ? repeatNumberError(fields.count, 'The occurrence count')
          : undefined) ??
        byDayError(spec) ??
        repeatUntilError(spec, date));
};

/**
 * Why a to-do draft cannot be written as it stands, in the task form's
 * own words, or undefined: the checks Save runs on the form, for a draft
 * that is not in it. A Google list holds none of the Reminders-only
 * fields, so only a Reminders list checks them.
 */
export const todoPrefillError = (
  prefill: QuickAddTaskPrefill,
  {
    extras,
    listKey,
    provider,
  }: {
    readonly extras?: DraftExtras | undefined;
    readonly listKey: string;
    readonly provider: TaskProvider;
  },
): string | undefined => {
  const [accountId, taskListId] = listKey.split(':', 2);
  if (!prefill.title.trim() || !accountId || !taskListId) {
    return 'A title and task list are required.';
  }
  const dated = extras?.undated !== true;
  if (dated && !DATE_RE.test(prefill.date)) {
    return 'A due date is required.';
  }
  if (provider !== 'apple') {
    return undefined;
  }
  if (dated && prefill.time !== undefined && !TIME_RE.test(prefill.time)) {
    return 'The due time must be HH:MM.';
  }
  const url = extras?.reminder?.url.trim();
  if (url && !URL.canParse(url)) {
    return 'The URL is not valid.';
  }
  // An undated reminder does not repeat: its rule is not written, nor checked.
  const repeat = dated ? extras?.reminder?.repeat : undefined;
  return repeat ? repeatError(repeat, prefill.date) : undefined;
};

/**
 * A to-do draft as the task form's create would write it, for a draft
 * that is not in the form: its fields, its notes, and on a Reminders list
 * its time and Reminders-only fields — on a Google list a link rides in
 * the notes instead, as the form does it. An undated one has no day, and
 * so no time or repeat rule either (EventKit refuses a rule without a day).
 */
export const taskFromPrefill = (
  prefill: QuickAddTaskPrefill,
  {
    extras,
    listKey,
    provider,
  }: {
    readonly extras?: DraftExtras | undefined;
    readonly listKey: string;
    readonly provider: TaskProvider;
  },
): NewTask => {
  const [accountId = '', taskListId = ''] = listKey.split(':', 2);
  const reminder = extras?.reminder;
  const url = reminder?.url.trim() ?? '';
  const ownNotes = extras?.taskNotes?.trim() || undefined;
  const notes = provider === 'google' ? appendLink(ownNotes, url || undefined) : ownNotes;
  const dated = extras?.undated !== true;
  const recurrence = dated && reminder ? repeatSpecFrom(reminder.repeat, prefill.date) : undefined;
  return {
    accountId,
    ...(dated ? { dueDate: prefill.date } : {}),
    ...(notes ? { notes } : {}),
    taskListId,
    title: prefill.title.trim(),
    ...(provider === 'apple'
      ? {
          ...(reminder && reminder.alarms.length > 0 ? { alarms: reminder.alarms } : {}),
          ...(dated && prefill.time !== undefined ? { dueTime: prefill.time } : {}),
          ...(reminder?.priority === undefined ? {} : { priority: reminder.priority }),
          ...(recurrence === undefined ? {} : { recurrence }),
          ...(url ? { url } : {}),
        }
      : {}),
  };
};

/** One write of the batch: a draft (by id) as an event or a to-do. */
export type DraftWrite =
  | { readonly event: EventDraft; readonly id: string; readonly kind: 'event' }
  | { readonly id: string; readonly kind: 'task'; readonly task: NewTask };

/**
 * What "Add all" will do: write the drafts beside the focused one, in
 * order — or nothing, when one of them could not be written, which the
 * form then shows with the reason. A draft whose calendar or list went
 * away (or turned read-only) since it was picked is one — the one it was
 * given, or the form's for a draft never given one: another place may
 * not hold what it holds (guests, a reminder's time), and nothing is
 * dropped unasked; the form shows it, in a place that takes it, to
 * confirm. No place at all is Save's own "required" message.
 */
export type AddAllPlan =
  | { readonly index: number; readonly kind: 'blocked'; readonly reason: string }
  | { readonly kind: 'ready'; readonly writes: ReadonlyArray<DraftWrite> };

const GONE_CALENDAR = 'The calendar picked for this draft is no longer available — pick another.';
const GONE_LIST = 'The list picked for this draft is no longer available — pick another.';

export const planAddAll = (
  state: DraftThreadState,
  {
    calendars,
    defaults,
    taskLists,
    timeZone,
  }: {
    readonly calendars: ReadonlyArray<CalendarInfo>;
    readonly defaults: DraftDefaults;
    readonly taskLists: ReadonlyArray<TaskListInfo>;
    readonly timeZone: string;
  },
): AddAllPlan => {
  const writes: Array<DraftWrite> = [];
  for (const [index, draft] of state.drafts.entries()) {
    if (index === state.focused) {
      continue;
    }
    const { extras, item } = draft;
    if (item.kind === 'event') {
      // Checked as given, never through a fallback, which may be the same gone calendar.
      const calendarKey = extras?.calendarKey ?? defaults.calendarKey;
      if (calendarKey !== '' && writableCalendarKey(calendars, calendarKey, '') !== calendarKey) {
        return { index, kind: 'blocked', reason: GONE_CALENDAR };
      }
      const reason = prefillError(item.prefill, { calendarKey, timeZone });
      if (reason !== undefined) {
        return { index, kind: 'blocked', reason };
      }
      const [accountId = '', calendarId = ''] = calendarKey.split(':', 2);
      const provider =
        calendars.find((calendar) => `${calendar.accountId}:${calendar.id}` === calendarKey)
          ?.provider ?? 'google';
      writes.push({
        event: eventDraftFromPrefill(item.prefill, {
          accountId,
          calendarId,
          canInvite: provider === 'google',
          extras,
          provider,
          timeZone,
        }),
        id: draft.id,
        kind: 'event',
      });
    } else {
      const listKey = extras?.listKey ?? defaults.listKey;
      if (listKey !== '' && !takesTodos(taskLists, listKey)) {
        return { index, kind: 'blocked', reason: GONE_LIST };
      }
      const provider =
        taskLists.find((list) => taskListKeyOf(list) === listKey)?.provider ?? 'google';
      const reason = todoPrefillError(item.prefill, { extras, listKey, provider });
      if (reason !== undefined) {
        return { index, kind: 'blocked', reason };
      }
      writes.push({
        id: draft.id,
        kind: 'task',
        task: taskFromPrefill(item.prefill, { extras, listKey, provider }),
      });
    }
  }
  return { kind: 'ready', writes };
};
