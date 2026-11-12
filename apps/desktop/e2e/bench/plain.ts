import {
  answerResult,
  type DraftState,
  draftState,
  type LanguageModel,
  type QuickAddPrefill,
  type QuickAddResult,
  type RefineResult,
  type TurnDraft,
} from '@calendar/ai';
import { upcomingDays } from '@calendar/ai/shared';
import { convertQuickAddItem } from '@calendar/app-state/quickAddItem';
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

/** The coming days by name: context for "next Tuesday", the same on every model (the app's own list). */
export const comingDays = upcomingDays;

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

/** The draft as the model reads it and writes it back (`DraftState` in `@calendar/ai`). */
export type PlainState = DraftState;

const eventOf = (draft: BenchDraft): QuickAddPrefill | undefined => {
  const asEvent = convertQuickAddItem(draft.item, 'event');
  return asEvent.kind === 'event' ? asEvent.prefill : undefined;
};

/** The bench's draft as a turn sees it: an event, a to-do seen as one. */
export const turnDraftOf = (draft: BenchDraft): TurnDraft | undefined => {
  const prefill = eventOf(draft);
  return prefill === undefined
    ? undefined
    : {
        guests: draft.guests.map((guest) => guest.email),
        kind: draft.item.kind,
        notes: draft.notes,
        prefill,
        reminders: draft.reminders,
      };
};

/** The bench's draft in the model's terms. */
export const plainState = (draft: BenchDraft): PlainState | undefined => {
  const turn = turnDraftOf(draft);
  return turn === undefined ? undefined : draftState(turn);
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

/**
 * The model's answer as a turn's result: the app's own code for it
 * (`answerResult` in `@calendar/ai`), which never reads the words.
 */
export const plainResult = (
  answer: unknown,
  {
    draft,
    referenceDate,
  }: { readonly draft: BenchDraft | undefined; readonly referenceDate: string },
): QuickAddResult | RefineResult =>
  answerResult(answer, {
    draft: draft === undefined ? undefined : turnDraftOf(draft),
    referenceDate,
  });

const REFUSED = "That couldn't be read — try rephrasing.";

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
