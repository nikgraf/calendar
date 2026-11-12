import {
  addHour,
  type LanguageModel,
  type NotesChange,
  type QuickAddPrefill,
  type QuickAddResult,
  recurrenceFromParse,
  type RefineResult,
  type ReminderChange,
  startOnRule,
} from '@calendar/ai';
import { convertQuickAddItem } from '@calendar/app-state/quickAddItem';
import { type ByDay, byDayError, Temporal, type Weekday } from '@calendar/core';
import type { BenchDraft } from './check.ts';

/**
 * The plain arm of the bench: what a model does when no code reads the
 * words. One prompt per turn states the product's conventions in prose
 * and asks for the whole draft; the code after it checks shapes (a real
 * date, a real time), fills the defaults a form would (an hour's length,
 * all day without a start), holds a repeat to the editor's own rules (it
 * starts on a day of its rule, an end that has passed is next year's)
 * and tells what changed from the draft before. It never looks at the
 * phrase. Run beside the app's pipeline
 * (`MODEL_BENCH_PIPELINE`), the two say what the grounding buys on a
 * model, and what a model does without it.
 */

/**
 * What the model is asked for: the draft after the turn, every part
 * optional but the title. The refusal is a flag that is false for an
 * ordinary phrase: asked the other way round ("understood"), the small
 * models answered false to phrases they had read correctly.
 */
export const PLAIN_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    date: { description: 'YYYY-MM-DD', type: 'string' },
    endTime: { description: 'HH:MM, 24-hour', type: 'string' },
    invite: { items: { type: 'string' }, type: 'array' },
    kind: { enum: ['event', 'task'], type: 'string' },
    location: { type: 'string' },
    notes: { type: 'string' },
    nothingToSchedule: { type: 'boolean' },
    reminders: {
      description: 'minutes before the start',
      items: { type: 'number' },
      type: 'array',
    },
    repeat: {
      additionalProperties: false,
      properties: {
        byDay: { description: 'MO, TU, …; 2TU, -1FR', items: { type: 'string' }, type: 'array' },
        count: { type: 'number' },
        freq: { enum: ['daily', 'weekly', 'monthly', 'yearly'], type: 'string' },
        interval: { type: 'number' },
        untilDate: { description: 'YYYY-MM-DD', type: 'string' },
      },
      required: ['freq'],
      type: 'object',
    },
    startTime: { description: 'HH:MM, 24-hour', type: 'string' },
    timeAssumed: { type: 'boolean' },
    title: { type: 'string' },
    uninvite: { items: { type: 'string' }, type: 'array' },
  },
  required: ['kind', 'nothingToSchedule', 'title'],
  type: 'object',
} as const;

const HINT_DAYS = 14;

/** The coming days by name: context for "next Tuesday", the same on every model. */
export const comingDays = (referenceDate: string): string =>
  Array.from({ length: HINT_DAYS }, (_, index) => {
    const date = Temporal.PlainDate.from(referenceDate).add({ days: index });
    const weekday = date.toLocaleString('en-US', { weekday: 'short' });
    return `${weekday} ${date.toString()}${index === 0 ? ' (today)' : ''}`;
  }).join(', ');

/** The product's conventions, as a person would be told them. */
const conventions = (referenceDate: string, timeZone: string): ReadonlyArray<string> => [
  'Conventions:',
  `- date: YYYY-MM-DD. Today is ${referenceDate} in time zone ${timeZone}. The coming days: ${comingDays(referenceDate)}. No day said means today.`,
  '- startTime and endTime: 24-hour HH:MM. Give a startTime for a clock time the words state. An hour said without am or pm takes the reading that fits the event (dinner at 8 is 20:00).',
  '- A meal or a part of the day said without a clock time takes its usual start, and timeAssumed is true: breakfast 08:00, brunch 11:00, lunch 12:30, dinner 19:00, morning 09:00, afternoon 14:00, evening or tonight 18:00, night 20:00.',
  '- No clock time and no meal or part of the day: leave startTime and endTime out. The event is all day.',
  '- endTime only when the words give an end or a length. Otherwise leave it out; it becomes one hour.',
  '- kind: "task" for something to do rather than attend, said as a to-do or a reminder to oneself ("remind me to …", "I need to …", "to-do: …", "don\'t forget to …", "ich muss …", "erinnere mich daran, … zu …"). Otherwise "event". A task\'s title is the thing to do, without those words.',
  '- title: what it is, in the words and the language of the speaker, without the day, the time, the place, the repeat, a note or a notification, and without command words around it ("add", "schedule", "create an event for"). Company stays in the title: "with Maria" is part of it.',
  '- location: the place, when one is said, without the word that leads to it ("at", "in", "im"). A person is never a place.',
  '- invite and uninvite: names or addresses exactly as said, only when the words ask to invite someone or to take someone off the guest list ("invite Ben", "add Ben as a guest", "lade Ben ein", "don\'t invite Ben", "remove Ben"). Someone the event is merely with ("lunch with Maria") is not invited.',
  '- repeat: only when the words say it repeats. freq is daily, weekly, monthly or yearly; interval for "every 2 weeks"; count for "5 times"; untilDate as YYYY-MM-DD; byDay lists the weekdays of a weekly rule as MO TU WE TH FR SA SU ("every weekday" is MO to FR), with a number in front for a monthly "second Tuesday" (2TU; -1FR is the last Friday).',
  '- notes: text the words ask to note down ("note: bring the contract"), as said.',
  '- reminders: the notifications the words ask for, each as minutes before the start ("remind me an hour before" and "erinnere mich eine Stunde vorher" are 60). Asking for one does not make a to-do.',
  '- nothingToSchedule: true only when the words give nothing to put in a calendar, or ask for something impossible (an end before its start). Otherwise false.',
  '- Never invent a value the words do not give.',
];

export const PLAIN_PHRASE_MARKER = 'Phrase: ';

/** The first phrase: a new event or to-do from one sentence. */
export const buildPlainPrompt = ({
  phrase,
  referenceDate,
  timeZone,
}: {
  readonly phrase: string;
  readonly referenceDate: string;
  readonly timeZone: string;
}): string =>
  [
    'Someone typed or dictated one phrase to add something to their calendar. Read it as they',
    'meant it and return the event or to-do as JSON.',
    ...conventions(referenceDate, timeZone),
    `${PLAIN_PHRASE_MARKER}${phrase}`,
  ].join('\n');

/** The draft as the model reads it and writes it back. */
export interface PlainState {
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

const eventOf = (draft: BenchDraft): QuickAddPrefill | undefined => {
  const asEvent = convertQuickAddItem(draft.item, 'event');
  return asEvent.kind === 'event' ? asEvent.prefill : undefined;
};

/** The bench's draft in the model's terms. */
export const plainState = (draft: BenchDraft): PlainState | undefined => {
  const prefill = eventOf(draft);
  if (prefill === undefined) {
    return undefined;
  }
  const repeat = prefill.recurrence;
  const byDay = (repeat?.byDay ?? []).map((day) => `${String(day.ordinal ?? '')}${day.weekday}`);
  const guests = draft.guests.map((guest) => guest.email);
  return {
    date: prefill.date,
    ...(prefill.isAllDay ? {} : { endTime: prefill.endTime }),
    ...(guests.length > 0 ? { guests } : {}),
    kind: draft.item.kind,
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

export const PLAIN_DRAFT_MARKER = 'Draft: ';
export const PLAIN_CHANGE_MARKER = 'Now: ';

/** A later turn: the draft, what was said so far, and what is said now. */
export const buildPlainRefinePrompt = ({
  earlier,
  referenceDate,
  state,
  timeZone,
  utterance,
}: {
  readonly earlier: ReadonlyArray<string>;
  readonly referenceDate: string;
  readonly state: PlainState;
  readonly timeZone: string;
  readonly utterance: string;
}): string =>
  [
    'Someone is adding something to their calendar by talking. Below are the draft so far as',
    'JSON, what they said before, and what they say now. Return the whole draft after what',
    'they say now: every part they did not speak about exactly as it is. A part left out of',
    'your answer is removed from the draft.',
    ...conventions(referenceDate, timeZone),
    'When changing a draft:',
    '- Words that only say where the place is (a city, a district, a street) narrow it: keep the place and add the where after a comma ("Blue Door" and "it\'s in Lisbon" make "Blue Door, Lisbon"). Words that name another place replace it.',
    '- Company said on its own ("with Maria") joins the title ("Lunch" becomes "Lunch with Maria"). Nobody is invited by it.',
    '- A new start keeps the length. "Later" or "earlier" by an amount moves start and end. A new length moves only the end.',
    '- An hour said without am or pm takes the reading nearest the start the draft has.',
    '- invite and uninvite hold only the names said now. guests lists who is invited already; do not return it.',
    '- kind stays as it is.',
    `${PLAIN_DRAFT_MARKER}${JSON.stringify(state)}`,
    `Said before: ${JSON.stringify(earlier)}`,
    `${PLAIN_CHANGE_MARKER}${utterance}`,
  ].join('\n');

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
 * The model's answer as a turn's result: shapes checked, a form's
 * defaults filled, a repeat held to the editor's rules, and the notes,
 * notifications and guests as changes to the draft before. Nothing here
 * reads the words.
 */
export const plainResult = (
  answer: unknown,
  {
    draft,
    referenceDate,
  }: { readonly draft: BenchDraft | undefined; readonly referenceDate: string },
): QuickAddResult | RefineResult => {
  if (!isRecord(answer)) {
    return { kind: 'rejected', reason: REFUSED };
  }
  const title = textOf(answer['title']);
  if (answer['nothingToSchedule'] === true || title === undefined) {
    return { kind: 'rejected', reason: 'Nothing to schedule was understood.' };
  }
  const before = draft === undefined ? undefined : eventOf(draft);
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

/** One turn through the plain arm: the first phrase, or a change to the draft. */
export const plainTurn = async (
  model: LanguageModel,
  {
    draft,
    earlier,
    referenceDate,
    text,
    timeZone,
  }: {
    readonly draft: BenchDraft | undefined;
    readonly earlier: ReadonlyArray<string>;
    readonly referenceDate: string;
    readonly text: string;
    readonly timeZone: string;
  },
): Promise<QuickAddResult | RefineResult> => {
  if (!text.trim()) {
    return { kind: 'rejected', reason: 'Type what you want to schedule.' };
  }
  const state = draft === undefined ? undefined : plainState(draft);
  if (draft !== undefined && state === undefined) {
    return { kind: 'rejected', reason: 'not an event' };
  }
  const prompt =
    state === undefined
      ? buildPlainPrompt({ phrase: text, referenceDate, timeZone })
      : buildPlainRefinePrompt({ earlier, referenceDate, state, timeZone, utterance: text });
  let answer: unknown;
  try {
    answer = await model.generateJson({ jsonSchema: PLAIN_JSON_SCHEMA, prompt });
  } catch {
    return { kind: 'rejected', reason: REFUSED };
  }
  return plainResult(answer, { draft, referenceDate });
};
