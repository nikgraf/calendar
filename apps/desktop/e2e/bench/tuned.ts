import type { LanguageModel, QuickAddResult, RefineResult } from '@calendar/ai';
import type { BenchDraft } from './check.ts';
import { comingDays, plainResult, type PlainState, plainState } from './plain.ts';
import { worked } from './said.ts';

/**
 * The tuned arm of the bench: a model trained for this one job, asked
 * without the conventions. The prompt is the days, the draft where there
 * is one, and the words; the answer is the draft as the plain arm asks
 * for it, written short (a part that is not there is left out, in one
 * fixed order), with a day the model cannot look up and a repeat's
 * ruled-out weekdays written as they were said (`said.ts` works them
 * out). The code after that is the plain arm's: shapes, a form's
 * defaults, never the phrase. A model that was not trained on these
 * prompts has nothing to go by, so this arm measures a training run and
 * nothing else. The training examples are made here too (`tunedExample`),
 * so what a model is trained on and what it is asked cannot drift apart.
 */

export const TUNED_PHRASE_MARKER = 'Phrase: ';
export const TUNED_DRAFT_MARKER = 'Draft: ';
export const TUNED_CHANGE_MARKER = 'Now: ';

/** The order a draft is written in, the model's answer and the draft it is shown alike. */
const ORDER = [
  'kind',
  'title',
  'date',
  'startTime',
  'endTime',
  'timeAssumed',
  'location',
  'repeat',
  'guests',
  'invite',
  'uninvite',
  'notes',
  'reminders',
] as const;

const REPEAT_ORDER = ['freq', 'interval', 'byDay', 'except', 'count', 'untilDate'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Nothing to write: a part that is absent, empty, or a flag that is off. */
const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  value === false ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

const inOrder = (
  source: Readonly<Record<string, unknown>>,
  order: ReadonlyArray<string>,
): Record<string, unknown> =>
  Object.fromEntries(
    order.flatMap((key) => {
      const value = source[key];
      return isBlank(value) ? [] : [[key, value]];
    }),
  );

/**
 * A draft written short: the parts it has, in the one order, a repeat's
 * parts likewise. Used for the answer a model is trained to give and for
 * the draft a later turn shows it.
 */
export const shortDraft = (draft: Readonly<Record<string, unknown>>): Record<string, unknown> => {
  const written = inOrder(draft, ORDER);
  const { repeat } = written;
  if (!isRecord(repeat)) {
    const { repeat: _none, ...rest } = written;
    return rest;
  }
  return { ...written, repeat: inOrder(repeat, REPEAT_ORDER) };
};

/**
 * A plain-arm answer as the tuned model is trained to write it: the
 * draft written short, or the one flag when there is nothing to put in a
 * calendar. Undefined for an answer that is no draft at all.
 */
export const tunedAnswer = (answer: unknown): Record<string, unknown> | undefined => {
  if (!isRecord(answer)) {
    return undefined;
  }
  if (answer['nothingToSchedule'] === true) {
    return { nothingToSchedule: true };
  }
  const written = shortDraft(answer);
  return typeof written['title'] === 'string' ? written : undefined;
};

/** The first phrase: the days to look a weekday up in, and the words. */
export const buildTunedPrompt = ({
  phrase,
  referenceDate,
}: {
  readonly phrase: string;
  readonly referenceDate: string;
}): string =>
  [
    'Calendar entry as JSON.',
    `Days: ${comingDays(referenceDate)}`,
    `${TUNED_PHRASE_MARKER}${phrase}`,
  ].join('\n');

/** A later turn: the days, the draft so far, what was said before, and what is said now. */
export const buildTunedRefinePrompt = ({
  earlier,
  referenceDate,
  state,
  utterance,
}: {
  readonly earlier: ReadonlyArray<string>;
  readonly referenceDate: string;
  readonly state: PlainState;
  readonly utterance: string;
}): string =>
  [
    'Calendar entry as JSON, after the change.',
    `Days: ${comingDays(referenceDate)}`,
    `${TUNED_DRAFT_MARKER}${JSON.stringify(shortDraft({ ...state }))}`,
    `Said before: ${JSON.stringify(earlier)}`,
    `${TUNED_CHANGE_MARKER}${utterance}`,
  ].join('\n');

interface TunedTurn {
  readonly draft: BenchDraft | undefined;
  readonly earlier: ReadonlyArray<string>;
  readonly referenceDate: string;
  readonly text: string;
}

/** The prompt of a turn, or undefined where the draft is nothing a turn can change. */
export const tunedPrompt = ({
  draft,
  earlier,
  referenceDate,
  text,
}: TunedTurn): string | undefined => {
  if (draft === undefined) {
    return buildTunedPrompt({ phrase: text, referenceDate });
  }
  const state = plainState(draft);
  return state === undefined
    ? undefined
    : buildTunedRefinePrompt({ earlier, referenceDate, state, utterance: text });
};

/** One line of training data: a turn's prompt and the answer to learn, as a chat. */
export interface TunedExample {
  readonly messages: readonly [
    { readonly content: string; readonly role: 'user' },
    { readonly content: string; readonly role: 'assistant' },
  ];
}

/**
 * A turn and the answer a teacher gave it through the plain arm, as a
 * training example. Undefined where there is nothing to learn from: no
 * prompt, or an answer that is no draft.
 */
export const tunedExample = (turn: TunedTurn, teacherAnswer: unknown): TunedExample | undefined => {
  const prompt = tunedPrompt(turn);
  const answer = tunedAnswer(teacherAnswer);
  return prompt === undefined || answer === undefined
    ? undefined
    : {
        messages: [
          { content: prompt, role: 'user' },
          { content: JSON.stringify(answer), role: 'assistant' },
        ],
      };
};

const REFUSED = "That couldn't be read — try rephrasing.";

/** One turn through the tuned arm: the first phrase, or a change to the draft. */
export const tunedTurn = async (
  model: LanguageModel,
  turn: TunedTurn,
): Promise<QuickAddResult | RefineResult> => {
  if (!turn.text.trim()) {
    return { kind: 'rejected', reason: 'Type what you want to schedule.' };
  }
  const prompt = tunedPrompt(turn);
  if (prompt === undefined) {
    return { kind: 'rejected', reason: 'not an event' };
  }
  let answer: unknown;
  try {
    // No schema: one held over the answer would have every field written, and the model learnt the short form.
    answer = await model.generateJson({ jsonSchema: undefined, prompt });
  } catch {
    return { kind: 'rejected', reason: REFUSED };
  }
  const draftDate = turn.draft === undefined ? undefined : plainState(turn.draft)?.date;
  return plainResult(worked(answer, { draftDate, referenceDate: turn.referenceDate }), {
    draft: turn.draft,
    referenceDate: turn.referenceDate,
  });
};
