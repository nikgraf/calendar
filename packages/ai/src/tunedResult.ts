import { type ByDay, byDayError, Temporal, type Weekday } from '@calendar/core';
import type { NotesChange, ReminderChange } from './extras.ts';
import {
  addHour,
  type QuickAddPrefill,
  type QuickAddResult,
  recurrenceFromParse,
  startOnRule,
} from './normalizeQuickAdd.ts';
import type { RefineResult } from './refine.ts';

/**
 * A draft as a turn of the tuned path sees it, whoever holds it: the app's
 * draft thread (`turnDraftOf` in app-state) or the bench's. An item is
 * seen as an event, a to-do with its due day and time as one; guests are
 * the addresses already on it.
 */
export interface TurnDraft {
  readonly guests: ReadonlyArray<string>;
  readonly kind: 'event' | 'task';
  readonly notes?: string | undefined;
  readonly prefill: QuickAddPrefill;
  /** Minutes before the start, as the draft's notifications are said. */
  readonly reminders?: ReadonlyArray<number> | undefined;
}

/**
 * The draft as a model reads it and writes it back: every part optional
 * but the kind, the title and the day.
 */
export interface DraftState {
  readonly date: string;
  readonly endTime?: string;
  readonly guests?: ReadonlyArray<string>;
  readonly kind: 'event' | 'task';
  readonly location?: string;
  readonly notes?: string;
  readonly reminders?: ReadonlyArray<number>;
  readonly repeat?: {
    readonly byDay?: ReadonlyArray<string>;
    readonly count?: number;
    readonly freq: string;
    readonly interval?: number;
    readonly untilDate?: string;
  };
  readonly startTime?: string;
  readonly timeAssumed?: boolean;
  readonly title: string;
}

/** A turn's draft in the model's terms. */
export const draftState = (draft: TurnDraft): DraftState => {
  const { prefill } = draft;
  const repeat = prefill.recurrence;
  const byDay = (repeat?.byDay ?? []).map((day) => `${String(day.ordinal ?? '')}${day.weekday}`);
  return {
    date: prefill.date,
    ...(prefill.isAllDay ? {} : { endTime: prefill.endTime }),
    ...(draft.guests.length > 0 ? { guests: draft.guests } : {}),
    kind: draft.kind,
    ...(prefill.location ? { location: prefill.location } : {}),
    ...(draft.notes ? { notes: draft.notes } : {}),
    ...(draft.reminders && draft.reminders.length > 0 ? { reminders: draft.reminders } : {}),
    ...(repeat === undefined
      ? {}
      : {
          repeat: {
            ...(byDay.length > 0 ? { byDay } : {}),
            ...(repeat.count === undefined ? {} : { count: repeat.count }),
            freq: repeat.freq,
            ...(repeat.interval === undefined ? {} : { interval: repeat.interval }),
            ...(repeat.untilDate === undefined ? {} : { untilDate: repeat.untilDate }),
          },
        }),
    ...(prefill.isAllDay ? {} : { startTime: prefill.startTime }),
    ...(prefill.assumedTime ? { timeAssumed: true } : {}),
    title: prefill.title,
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textOf = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

const dateOf = (value: unknown): string | undefined => {
  const text = textOf(value);
  if (text === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(text)) {
    return undefined;
  }
  try {
    return Temporal.PlainDate.from(text, { overflow: 'reject' }).toString();
  } catch {
    return undefined;
  }
};

const timeOf = (value: unknown): string | undefined => {
  const match = /^(\d{1,2}):(\d{2})$/u.exec(textOf(value) ?? '');
  if (match === null) {
    return undefined;
  }
  const [hour, minute] = [Number(match[1]), Number(match[2])];
  return hour < 24 && minute < 60
    ? `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
    : undefined;
};

const namesOf = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value) ? value.flatMap((name) => textOf(name) ?? []) : [];

const FREQS = ['daily', 'weekly', 'monthly', 'yearly'] as const;
const BY_DAY = /^(-?\d)?(MO|TU|WE|TH|FR|SA|SU)$/u;

const byDayOf = (value: unknown): ReadonlyArray<ByDay> => {
  const match = BY_DAY.exec((textOf(value) ?? '').toUpperCase());
  if (match === null) {
    return [];
  }
  const weekday = match[2] as Weekday;
  return [match[1] === undefined ? { weekday } : { ordinal: Number(match[1]), weekday }];
};

/**
 * The repeat as the editor holds it, and the day it starts on. The rule
 * is validated as the app validates a model's (`recurrenceFromParse`
 * without a phrase): a real frequency, "repeats once" being none, an end
 * on or after the day. Days the editor would refuse on Save are not kept
 * ("monthly on Wednesday" without saying which).
 */
const repeatOf = (
  raw: unknown,
  date: string,
): { readonly date: string; readonly recurrence: QuickAddPrefill['recurrence'] } => {
  if (!isRecord(raw)) {
    return { date, recurrence: undefined };
  }
  const rule = recurrenceFromParse(
    {
      count: typeof raw['count'] === 'number' ? raw['count'] : undefined,
      freq: FREQS.find((known) => known === raw['freq']),
      interval: typeof raw['interval'] === 'number' ? raw['interval'] : undefined,
      untilDate: dateOf(raw['untilDate']),
    },
    date,
  );
  if (rule === undefined) {
    return { date, recurrence: undefined };
  }
  const said = Array.isArray(raw['byDay']) ? raw['byDay'].flatMap(byDayOf) : [];
  const byDay = byDayError({ byDay: said, freq: rule.freq }) === undefined ? said : [];
  const placed = startOnRule(date, { ...rule, ...(byDay.length > 0 ? { byDay } : {}) });
  const kept = placed.recurrence;
  // One weekday of a weekly rule is the date's own: the editor lists none.
  if (kept?.freq === 'weekly' && kept.byDay?.length === 1) {
    const { byDay: _single, ...rest } = kept;
    return { date: placed.date, recurrence: rest };
  }
  return placed;
};

const sameNumbers = (a: ReadonlyArray<number>, b: ReadonlyArray<number>): boolean =>
  [...a].sort((x, y) => x - y).join(',') === [...b].sort((x, y) => x - y).join(',');

/** What the answer's notes do to the draft's: nothing when they read the same. */
const notesChange = (answer: unknown, before: string | undefined): NotesChange | undefined => {
  const now = textOf(answer);
  if (now === (before?.trim() || undefined)) {
    return undefined;
  }
  if (now === undefined) {
    return { kind: 'clear' };
  }
  return before === undefined ? { kind: 'add', text: now } : { kind: 'replace', text: now };
};

/** What the answer's notifications do to the draft's: the answer is the list after the turn. */
const remindersChange = (
  answer: unknown,
  before: ReadonlyArray<number> | undefined,
): ReminderChange | undefined => {
  const now = Array.isArray(answer)
    ? answer.filter(
        (minutes): minutes is number =>
          typeof minutes === 'number' && Number.isInteger(minutes) && minutes >= 0,
      )
    : [];
  if (sameNumbers(now, before ?? [])) {
    return undefined;
  }
  return { add: now, clear: before !== undefined && before.length > 0, remove: [] };
};

const REFUSED = "That couldn't be read — try rephrasing.";

/**
 * A model's answer (the whole draft after the turn) as a turn's result:
 * shapes checked, a form's defaults filled, a repeat held to the editor's
 * rules, and the notes, notifications and guests as changes to the draft
 * before. Nothing here reads the words.
 */
export const answerResult = (
  answer: unknown,
  {
    draft,
    referenceDate,
  }: { readonly draft: TurnDraft | undefined; readonly referenceDate: string },
): QuickAddResult | RefineResult => {
  if (!isRecord(answer)) {
    return { kind: 'rejected', reason: REFUSED };
  }
  const title = textOf(answer['title']);
  if (answer['nothingToSchedule'] === true || title === undefined) {
    return { kind: 'rejected', reason: 'Nothing to schedule was understood.' };
  }
  const before = draft?.prefill;
  const said = dateOf(answer['date']) ?? before?.date ?? referenceDate;
  const start = timeOf(answer['startTime']);
  const notes = notesChange(answer['notes'], draft?.notes);
  if (draft === undefined && answer['kind'] === 'task') {
    return {
      kind: 'task',
      ...(notes === undefined ? {} : { notes }),
      prefill: { date: said, ...(start === undefined ? {} : { time: start }), title },
    };
  }
  const end = timeOf(answer['endTime']);
  const startTime = start ?? '00:00';
  const { date, recurrence } = repeatOf(answer['repeat'], said);
  const location = textOf(answer['location']);
  const reminders = remindersChange(answer['reminders'], draft?.reminders);
  const invite = namesOf(answer['invite']);
  const uninvite = namesOf(answer['uninvite']);
  return {
    ...(invite.length > 0 ? { invite } : {}),
    kind: 'parsed',
    ...(notes === undefined ? {} : { notes }),
    prefill: {
      ...(start !== undefined && answer['timeAssumed'] === true ? { assumedTime: true } : {}),
      date,
      ...(before?.endDate === undefined ? {} : { endDate: before.endDate }),
      endTime: end !== undefined && end > startTime ? end : addHour(startTime),
      isAllDay: start === undefined,
      ...(location === undefined ? {} : { location }),
      ...(recurrence === undefined ? {} : { recurrence }),
      startTime,
      title,
    },
    ...(reminders === undefined ? {} : { reminders }),
    ...(uninvite.length > 0 ? { uninvite } : {}),
  };
};
