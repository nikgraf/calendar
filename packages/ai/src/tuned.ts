import type { LanguageModel } from './model.ts';
import type { QuickAddResult, RefineResult } from './normalizeQuickAdd.ts';
import { worked, workedTimes } from './said.ts';
import { upcomingDays } from './shared.ts';
import { answerResult, type DraftState, draftState, type TurnDraft } from './tunedResult.ts';

/**
 * The tuned path: a model trained for this one job, asked without the
 * product's conventions. The prompt is the days, the draft where there is
 * one, and the words; the answer is the whole draft after the turn,
 * written short (a part that is not there is left out, in one fixed
 * order), with a day the model cannot look up and a repeat's ruled-out
 * weekdays written as they were said (`said.ts` works them out). The code
 * after that (`answerResult`) checks shapes and fills a form's defaults,
 * and never reads the phrase. A model that was not trained on these
 * prompts has nothing to go by. The prompt's bytes are the ones the model
 * was trained on (the bench's `train/` makes the data with these same
 * functions): a change here needs a model trained again.
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
    `Days: ${upcomingDays(referenceDate)}`,
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
  readonly state: DraftState;
  readonly utterance: string;
}): string =>
  [
    'Calendar entry as JSON, after the change.',
    `Days: ${upcomingDays(referenceDate)}`,
    `${TUNED_DRAFT_MARKER}${JSON.stringify(shortDraft({ ...state }))}`,
    `Said before: ${JSON.stringify(earlier)}`,
    `${TUNED_CHANGE_MARKER}${utterance}`,
  ].join('\n');

/** A turn of the tuned path: the draft it changes (none for a first phrase), what was said before, the words. */
export interface TunedTurn {
  readonly draft: TurnDraft | undefined;
  readonly earlier: ReadonlyArray<string>;
  readonly referenceDate: string;
  readonly text: string;
}

/** The prompt of a turn. */
export const tunedPrompt = ({ draft, earlier, referenceDate, text }: TunedTurn): string =>
  draft === undefined
    ? buildTunedPrompt({ phrase: text, referenceDate })
    : buildTunedRefinePrompt({ earlier, referenceDate, state: draftState(draft), utterance: text });

const REFUSED = "That couldn't be read — try rephrasing.";

/** One turn through the tuned path: the first phrase, or a change to the draft. */
export const tunedTurn = async (
  model: LanguageModel,
  turn: TunedTurn,
  {
    adjust,
  }: {
    /** Changes the worked-out answer before its result is made (the day on show, for words that name none). */
    readonly adjust?: ((answer: unknown) => unknown) | undefined;
  } = {},
): Promise<QuickAddResult | RefineResult> => {
  if (!turn.text.trim()) {
    return { kind: 'rejected', reason: 'Type what you want to schedule.' };
  }
  let answer: unknown;
  try {
    // No schema: one held over the answer would have every field written, and the model learnt the short form.
    answer = await model.generateJson({ jsonSchema: undefined, prompt: tunedPrompt(turn) });
  } catch {
    return { kind: 'rejected', reason: REFUSED };
  }
  const day = workedTimes(
    worked(answer, { draftDate: turn.draft?.prefill.date, referenceDate: turn.referenceDate }),
    { draft: turn.draft?.prefill },
  );
  return answerResult(adjust === undefined ? day : adjust(day), {
    draft: turn.draft,
    referenceDate: turn.referenceDate,
  });
};
