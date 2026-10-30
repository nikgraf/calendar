import type { QuickAddResult, RefineResult } from '@calendar/ai';
import { applyNotesChange, applyReminderChange } from '@calendar/app-state/draftExtras';
import {
  applyGuestChange,
  type InviteeChoice,
  resolveInvitees,
} from '@calendar/app-state/draftInvitees';
import { convertQuickAddItem, type QuickAddItem } from '@calendar/app-state/quickAddItem';
import {
  type AttendeeInput,
  type Contact,
  contactsNamed,
  emailKey,
  EventReminders,
  foldSearchText,
  ReminderOverride,
  Temporal,
} from '@calendar/core';
import type { Expectation } from './cases.ts';

/**
 * What the bench holds between turns and checks after each: the thread's
 * draft without the UI. The item is the editor's own prefill; guests and
 * choices are what the thread's `guestsOf` would make of the names, over
 * the fixture address book; notes and notifications are what the words
 * added, as the thread folds them in (`draftExtras.ts`).
 */
export interface BenchDraft {
  readonly choices: ReadonlyArray<InviteeChoice>;
  readonly guests: ReadonlyArray<AttendeeInput>;
  readonly item: QuickAddItem;
  readonly notes?: string | undefined;
  /** Minutes before the start. */
  readonly reminders?: ReadonlyArray<number> | undefined;
}

export type Outcome =
  | { readonly draft: BenchDraft; readonly kind: 'draft' }
  | { readonly kind: 'rejected'; readonly reason: string };

/** What an expectation can be about; the score counts each apart. */
export type Field =
  | 'allDay'
  | 'date'
  | 'guests'
  | 'kind'
  | 'location'
  | 'notes'
  | 'rejected'
  | 'reminders'
  | 'repeat'
  | 'time'
  | 'title'
  /** A later turn left every field it was not about as it was. */
  | 'unchanged';

/** In the order the score prints them. */
export const FIELDS: ReadonlyArray<Field> = [
  'kind',
  'title',
  'date',
  'time',
  'allDay',
  'location',
  'repeat',
  'guests',
  'notes',
  'reminders',
  'unchanged',
  'rejected',
];

export interface TurnCheck {
  /** Every field the expectation (and the unchanged rule) covered. */
  readonly checked: ReadonlyArray<Field>;
  readonly failed: ReadonlyArray<Field>;
  /** One line per failure, for the table. */
  readonly notes: ReadonlyArray<string>;
}

/** Case, accents, ß and runs of spaces folded away: what text is compared as. */
export const fold = (text: string): string =>
  foldSearchText(text).replaceAll('ß', 'ss').replaceAll(/\s+/gu, ' ').trim();

/** The popup offsets of the form's notifications, the way an expectation names them. */
const minutesOf = (reminders: EventReminders | undefined): ReadonlyArray<number> | undefined =>
  reminders === undefined
    ? undefined
    : reminders.overrides
        .filter((override) => override.method === 'popup')
        .map((override) => override.minutes);

const remindersOf = (minutes: ReadonlyArray<number> | undefined): EventReminders | undefined =>
  minutes === undefined
    ? undefined
    : new EventReminders({
        overrides: minutes.map(
          (offset) => new ReminderOverride({ method: 'popup', minutes: offset }),
        ),
        useDefault: false,
      });

/**
 * The draft after a turn's result: the first turn makes it, a later one
 * changes it as the thread would — the kind kept, the guests the words
 * invite looked up in the address book (`resolveInvitees`, every match
 * of `contactsNamed`), the ones they take off removed, a note added to
 * the notes, the notifications said added to the draft's.
 */
export const applyResult = async (
  previous: BenchDraft | undefined,
  result: QuickAddResult | RefineResult,
  book: ReadonlyArray<Contact>,
): Promise<Outcome> => {
  if (result.kind === 'rejected') {
    return { kind: 'rejected', reason: result.reason };
  }
  const notes =
    result.notes === undefined
      ? previous?.notes
      : applyNotesChange(previous?.notes ?? '', result.notes);
  if (result.kind === 'task') {
    return {
      draft: {
        choices: [],
        guests: [],
        item: { kind: 'task', prefill: result.prefill },
        notes,
        reminders: previous?.reminders,
      },
      kind: 'draft',
    };
  }
  const parsed: QuickAddItem = { kind: 'event', prefill: result.prefill };
  const item = previous === undefined ? parsed : convertQuickAddItem(parsed, previous.item.kind);
  const invite = result.invite ?? [];
  const uninvite = result.uninvite ?? [];
  let guests = previous?.guests ?? [];
  let choices = previous?.choices ?? [];
  if (item.kind === 'event' && (invite.length > 0 || uninvite.length > 0)) {
    const found = await resolveInvitees(invite, (name) =>
      Promise.resolve(contactsNamed(name, book)),
    );
    const applied = applyGuestChange(guests, choices, {
      ...found,
      invited: invite,
      remove: uninvite,
    });
    guests = applied.attendees;
    choices = applied.choices;
  }
  const reminders =
    result.reminders === undefined || item.kind !== 'event'
      ? previous?.reminders
      : minutesOf(
          applyReminderChange(remindersOf(previous?.reminders), result.reminders).reminders,
        );
  return {
    draft: { choices, guests, item, notes, reminders },
    kind: 'draft',
  };
};

const sortedNumbers = (values: ReadonlyArray<number>): string =>
  [...values].sort((a, b) => a - b).join(',');

const sortedText = (values: ReadonlyArray<string>): string => [...values].sort().join(',');

const describeRepeat = (
  repeat: Extract<QuickAddItem, { kind: 'event' }>['prefill']['recurrence'],
): string =>
  repeat === undefined
    ? '-'
    : [
        repeat.freq,
        repeat.byDay === undefined || repeat.byDay.length === 0
          ? undefined
          : `on ${repeat.byDay.map((day) => `${String(day.ordinal ?? '')}${day.weekday}`).join(',')}`,
        repeat.interval === undefined ? undefined : `every ${String(repeat.interval)}`,
        repeat.count === undefined ? undefined : `${String(repeat.count)}x`,
        repeat.untilDate === undefined ? undefined : `until ${repeat.untilDate}`,
      ]
        .filter(Boolean)
        .join(' ');

const describeGuests = (draft: BenchDraft): string =>
  `guests=${draft.guests.map((guest) => emailKey(guest.email)).join(',') || '-'}; choices=${
    draft.choices.map((choice) => choice.name).join(',') || '-'
  }`;

/**
 * The draft as the unchanged rule sees it: one string per part, so a
 * later turn's draft can be held against the one before. Times and
 * all-day-ness are one part — a turn that sets a time on an all-day
 * draft changes both, and an expectation about either covers it.
 */
const VIEW_KEYS = [
  'date',
  'guests',
  'kind',
  'location',
  'notes',
  'reminders',
  'repeat',
  'time',
  'title',
] as const;
type ViewKey = (typeof VIEW_KEYS)[number];

const viewOf = (draft: BenchDraft): Readonly<Record<ViewKey, string>> => {
  const { item } = draft;
  return {
    date: item.prefill.date,
    guests: `${sortedText(draft.guests.map((guest) => emailKey(guest.email)))}|${sortedText(
      draft.choices.map((choice) => fold(choice.name)),
    )}`,
    kind: item.kind,
    location: item.kind === 'event' ? fold(item.prefill.location ?? '') : '',
    notes: fold(draft.notes ?? ''),
    reminders: sortedNumbers(draft.reminders ?? []),
    repeat: item.kind === 'event' ? describeRepeat(item.prefill.recurrence) : '-',
    time:
      item.kind === 'event'
        ? item.prefill.isAllDay
          ? 'all day'
          : `${item.prefill.startTime}-${item.prefill.endTime}`
        : (item.prefill.time ?? 'no time'),
    title: fold(item.prefill.title),
  };
};

/**
 * What an expectation's keys are about: the field the score counts, and
 * the part of the draft the unchanged rule then leaves to it. Times and
 * all-day-ness share a part.
 */
const ABOUT: ReadonlyArray<{
  readonly field: Field;
  readonly keys: ReadonlyArray<keyof Expectation>;
  readonly view: ViewKey;
}> = [
  { field: 'kind', keys: ['kind'], view: 'kind' },
  { field: 'title', keys: ['title', 'titleIncludes'], view: 'title' },
  { field: 'date', keys: ['weekday', 'dayOffset'], view: 'date' },
  { field: 'time', keys: ['startTime', 'endTime', 'assumedTime'], view: 'time' },
  { field: 'allDay', keys: ['isAllDay'], view: 'time' },
  { field: 'location', keys: ['location'], view: 'location' },
  { field: 'repeat', keys: ['repeat'], view: 'repeat' },
  { field: 'guests', keys: ['guests'], view: 'guests' },
  { field: 'notes', keys: ['notes'], view: 'notes' },
  { field: 'reminders', keys: ['reminders'], view: 'reminders' },
];

const about = (expectation: Expectation) =>
  ABOUT.filter((entry) => entry.keys.some((key) => expectation[key] !== undefined));

/** The parts an expectation is about, which the unchanged rule leaves to it. */
const coveredViews = (expectation: Expectation): ReadonlySet<ViewKey> =>
  new Set(about(expectation).map((entry) => entry.view));

/** The fields an expectation scores. */
export const fieldsOf = (expectation: Expectation): ReadonlyArray<Field> =>
  expectation.rejected ? ['rejected'] : about(expectation).map((entry) => entry.field);

/**
 * Which of the expectation the outcome meets. A turn after the first is
 * also held to the unchanged rule: every part of the draft the
 * expectation is not about must read as it did before the turn — the
 * failure a refinement is most prone to is changing what it was not
 * asked to. A rejection fails every field the expectation named, unless
 * it was the expectation.
 */
export const check = (
  expectation: Expectation,
  outcome: Outcome,
  previous: BenchDraft | undefined,
  today: string,
): TurnCheck => {
  const checked: Array<Field> = [...fieldsOf(expectation)];
  if (previous !== undefined && !expectation.rejected) {
    checked.push('unchanged');
  }
  if (expectation.rejected) {
    return outcome.kind === 'rejected'
      ? { checked, failed: [], notes: [] }
      : { checked, failed: ['rejected'], notes: ['accepted, a rejection was expected'] };
  }
  if (outcome.kind === 'rejected') {
    return { checked, failed: checked, notes: [`rejected: ${outcome.reason}`] };
  }
  const { draft } = outcome;
  const { item } = draft;
  const failed = new Set<Field>();
  const notes: Array<string> = [];
  const fail = (field: Field, note: string) => {
    failed.add(field);
    notes.push(note);
  };

  if (expectation.kind !== undefined && item.kind !== expectation.kind) {
    fail('kind', `kind=${item.kind}`);
  }

  const title = fold(item.prefill.title);
  if (expectation.title !== undefined) {
    const accepted =
      typeof expectation.title === 'string' ? [expectation.title] : expectation.title;
    if (!accepted.map(fold).includes(title)) {
      fail('title', `title=${item.prefill.title}`);
    }
  }
  if (expectation.titleIncludes !== undefined && !title.includes(fold(expectation.titleIncludes))) {
    fail('title', `title=${item.prefill.title}`);
  }

  const date = Temporal.PlainDate.from(item.prefill.date);
  if (expectation.weekday !== undefined && date.dayOfWeek !== expectation.weekday) {
    fail('date', `weekday=${String(date.dayOfWeek)} (${item.prefill.date})`);
  }
  if (
    expectation.dayOffset !== undefined &&
    Temporal.PlainDate.from(today).until(date).days !== expectation.dayOffset
  ) {
    fail('date', `day=${item.prefill.date}`);
  }

  const allDay = item.kind === 'event' ? item.prefill.isAllDay : item.prefill.time === undefined;
  const start =
    item.kind === 'event' ? (allDay ? undefined : item.prefill.startTime) : item.prefill.time;
  const end = item.kind === 'event' && !allDay ? item.prefill.endTime : undefined;
  if (expectation.startTime !== undefined && start !== expectation.startTime) {
    fail('time', `start=${start ?? '-'}`);
  }
  if (expectation.endTime !== undefined && end !== expectation.endTime) {
    fail('time', `end=${end ?? '-'}`);
  }
  const assumed = item.kind === 'event' && item.prefill.assumedTime === true;
  if (expectation.assumedTime !== undefined && assumed !== expectation.assumedTime) {
    fail('time', `assumed=${String(assumed)}`);
  }
  if (expectation.isAllDay !== undefined && allDay !== expectation.isAllDay) {
    fail('allDay', `allDay=${String(allDay)}`);
  }

  const location = item.kind === 'event' ? item.prefill.location : undefined;
  if (expectation.location === null && location !== undefined) {
    fail('location', `location=${location}`);
  }
  if (
    typeof expectation.location === 'string' &&
    !fold(location ?? '').includes(fold(expectation.location))
  ) {
    fail('location', `location=${location ?? '-'}`);
  }

  const repeat = item.kind === 'event' ? item.prefill.recurrence : undefined;
  if (expectation.repeat === null && repeat !== undefined) {
    fail('repeat', `repeat=${describeRepeat(repeat)}`);
  }
  if (expectation.repeat) {
    const wanted = expectation.repeat;
    const untilMonth =
      repeat?.untilDate === undefined ? undefined : Temporal.PlainDate.from(repeat.untilDate).month;
    const matches =
      repeat !== undefined &&
      repeat.freq === wanted.freq &&
      (repeat.interval ?? 1) === (wanted.interval ?? 1) &&
      (wanted.byDay === undefined ||
        sortedText((repeat.byDay ?? []).map((day) => day.weekday)) === sortedText(wanted.byDay)) &&
      (wanted.count === undefined || repeat.count === wanted.count) &&
      (wanted.untilMonth === undefined || untilMonth === wanted.untilMonth);
    if (!matches) {
      fail('repeat', `repeat=${describeRepeat(repeat)}`);
    }
  }

  if (expectation.guests !== undefined) {
    const emails = sortedText(draft.guests.map((guest) => emailKey(guest.email)));
    const wantedEmails = sortedText((expectation.guests.emails ?? []).map(emailKey));
    const choices = sortedText(draft.choices.map((choice) => fold(choice.name)));
    const wantedChoices = sortedText((expectation.guests.choices ?? []).map(fold));
    if (emails !== wantedEmails || choices !== wantedChoices) {
      fail('guests', describeGuests(draft));
    }
  }

  if (
    expectation.notes !== undefined &&
    !fold(draft.notes ?? '').includes(fold(expectation.notes))
  ) {
    fail('notes', `notes=${draft.notes ?? '-'}`);
  }

  if (
    expectation.reminders !== undefined &&
    sortedNumbers(draft.reminders ?? []) !== sortedNumbers(expectation.reminders)
  ) {
    fail('reminders', `reminders=${sortedNumbers(draft.reminders ?? []) || '-'}`);
  }

  if (previous !== undefined) {
    const covered = coveredViews(expectation);
    const before = viewOf(previous);
    const after = viewOf(draft);
    for (const key of VIEW_KEYS) {
      if (before[key] !== after[key] && !covered.has(key)) {
        fail('unchanged', `changed ${key}: ${after[key] || '-'}`);
      }
    }
  }

  return { checked, failed: [...failed], notes };
};

/** Words as the recogniser is held to them: folded, without the punctuation around them. */
const tokens = (text: string): ReadonlyArray<string> =>
  fold(text)
    .split(' ')
    .map((word) => word.replaceAll(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean);

/**
 * Word error rate: the edits (substitutions, insertions, deletions) that
 * turn what was said into what was heard, over the words said. 0 for a
 * perfect transcription; above 1 is possible when far more was heard.
 */
export const wordErrorRate = (said: string, heard: string): number => {
  const reference = tokens(said);
  const hypothesis = tokens(heard);
  let previous = Array.from({ length: hypothesis.length + 1 }, (_, index) => index);
  for (let row = 1; row <= reference.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= hypothesis.length; column += 1) {
      const same = reference[row - 1] === hypothesis[column - 1];
      current.push(
        Math.min(
          previous[column]! + 1,
          current[column - 1]! + 1,
          previous[column - 1]! + (same ? 0 : 1),
        ),
      );
    }
    previous = current;
  }
  return previous[hypothesis.length]! / Math.max(1, reference.length);
};
