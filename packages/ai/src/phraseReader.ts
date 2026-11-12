import { validateEventDraft } from '@calendar/core';
import { defersDate, groundDate, mentionsDate } from './grounding.ts';
import { type LanguageModel, ModelUnavailableError } from './model.ts';
import type { QuickAddResult } from './normalizeQuickAdd.ts';
import { parseQuickAdd } from './parseQuickAdd.ts';
import { parseRefine, type RefineResult } from './refine.ts';
import { tunedTurn } from './tuned.ts';
import type { TurnDraft } from './tunedResult.ts';

/**
 * How the Assistant reads what is said, whichever model reads it: a first
 * phrase that makes an item, or words that change one. The draft thread
 * (app-state) asks a reader and does the rest itself: guests looked up,
 * places found, what an item cannot hold refused, the step written.
 *
 * - `rulesReader`: the app's own pipeline (`parseQuickAdd`, `parseRefine`)
 *   with its grounding, over a general model (Apple's, a served one).
 * - `tunedReader`: the tuned path (`tuned.ts`) over a model trained for it,
 *   which needs none of the grounding.
 */

export interface FirstPhrase {
  /** The day the item lands on when the words give none: the one on show. */
  readonly fallbackDate?: string | undefined;
  readonly phrase: string;
  readonly referenceDate: string;
  readonly timeZone: string;
}

export interface ChangePhrase {
  readonly draft: TurnDraft;
  /** Whether words about people are about guests: a to-do's are its title's. */
  readonly guests?: boolean | undefined;
  /** The place as said, for a turn that only says where it is. */
  readonly placeSaid?: string | undefined;
  readonly referenceDate: string;
  /** The words of the earlier turns that made or changed this draft, oldest first. */
  readonly said: ReadonlyArray<string>;
  readonly timeZone: string;
  readonly utterance: string;
}

export interface PhraseReader {
  readonly change: (input: ChangePhrase) => Promise<RefineResult>;
  readonly first: (input: FirstPhrase) => Promise<QuickAddResult>;
}

/** The app's pipeline with its grounding: what the draft thread used before readers. */
export const rulesReader = (model: LanguageModel): PhraseReader => ({
  change: ({ draft, guests, placeSaid, referenceDate, said, timeZone, utterance }) =>
    parseRefine(model, {
      draft: draft.prefill,
      guests,
      placeSaid,
      referenceDate,
      said,
      timeZone,
      utterance,
    }),
  first: (input) => parseQuickAdd(model, input),
});

/** Earlier turns a later one is shown, newest kept: the model was trained on short threads. */
const SAID_BEFORE = 6;

/**
 * Notes a turn shows the model only when they are short and plain: a
 * saved event's long description is not the model's to rewrite, and any
 * byte it wrote back differently would replace it.
 */
const NOTES_SHOWN = 200;

const shownNotes = (notes: string | undefined): string | undefined =>
  notes !== undefined && notes.length <= NOTES_SHOWN && !notes.includes('\n') ? notes : undefined;

const unavailable = async (model: LanguageModel): Promise<void> => {
  const status = await model.status();
  if (status !== 'ready') {
    throw new ModelUnavailableError({ message: `The Assistant's model is ${status}.` });
  }
};

/** Whether the words name a day the code can read ("today", a weekday) or mention one. */
const statesDay = (words: string, referenceDate: string): boolean =>
  groundDate(undefined, { phrase: words, referenceDate }) !== undefined ||
  mentionsDate(words) ||
  defersDate(words);

/** A refusal for a day and times no calendar can hold (a time that does not exist that day). */
const invalidIn = (result: QuickAddResult, timeZone: string): string | undefined =>
  result.kind === 'parsed'
    ? (validateEventDraft(
        {
          calendarKey: 'placeholder:placeholder',
          date: result.prefill.date,
          ...(result.prefill.endDate === undefined ? {} : { endDate: result.prefill.endDate }),
          endTime: result.prefill.endTime,
          isAllDay: result.prefill.isAllDay,
          startTime: result.prefill.startTime,
          title: result.prefill.title,
        },
        timeZone,
      ) ?? undefined)
    : undefined;

/**
 * The tuned path as a reader. What it adds to the bench's turn is what
 * the app's path gives the thread: the model's readiness checked first;
 * the day on show for words that name no day (the model writes today's,
 * as it was taught); whether a later turn's words gave the day; the
 * calendar's own check of the result; and notes shown only when short.
 */
export const tunedReader = (model: LanguageModel): PhraseReader => ({
  change: async ({ draft, referenceDate, said, timeZone, utterance }) => {
    await unavailable(model);
    const shown: TurnDraft = { ...draft, notes: shownNotes(draft.notes) };
    const result = await tunedTurn(model, {
      draft: shown,
      earlier: said.slice(-SAID_BEFORE),
      referenceDate,
      text: utterance,
    });
    if (result.kind !== 'parsed') {
      return result.kind === 'task'
        ? { kind: 'rejected', reason: 'Nothing to change was understood.' }
        : result;
    }
    const invalid = invalidIn(result, timeZone);
    if (invalid !== undefined) {
      return { kind: 'rejected', reason: invalid };
    }
    return statesDay(utterance, referenceDate) ? { ...result, saidDay: true } : result;
  },
  first: async ({ fallbackDate, phrase, referenceDate, timeZone }) => {
    await unavailable(model);
    const result = await tunedTurn(model, {
      draft: undefined,
      earlier: [],
      referenceDate,
      text: phrase,
    });
    if (result.kind === 'rejected') {
      return result;
    }
    // No day in the words: the day on show, not today.
    const onShow =
      fallbackDate !== undefined &&
      result.prefill.date === referenceDate &&
      !statesDay(phrase, referenceDate);
    const placed = onShow
      ? ({ ...result, prefill: { ...result.prefill, date: fallbackDate } } as QuickAddResult)
      : result;
    const invalid = invalidIn(placed, timeZone);
    return invalid === undefined ? placed : { kind: 'rejected', reason: invalid };
  },
});
