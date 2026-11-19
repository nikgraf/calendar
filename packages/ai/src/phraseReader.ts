import { validateEventDraft } from '@calendar/core';
import { type LanguageModel, ModelUnavailableError } from './model.ts';
import type { QuickAddResult, RefineResult } from './normalizeQuickAdd.ts';
import { tunedTurn } from './tuned.ts';
import type { TurnDraft } from './tunedResult.ts';

/**
 * How the Assistant reads what is said: a first phrase that makes an item,
 * or words that change one, read by the app's own model through the tuned
 * path (`tuned.ts`). The draft thread (app-state) asks a reader and does
 * the rest itself: guests looked up, places found, what an item cannot
 * hold refused, the step written.
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

/** Whether an answer wrote a day: the model writes one only where the words gave it. */
const writesDay = (answer: unknown): boolean =>
  typeof answer === 'object' &&
  answer !== null &&
  (answer as { date?: unknown }).date !== undefined;

/**
 * The tuned path as a reader. What it adds to the bench's turn is what
 * the app's path gives the thread: the model's readiness checked first;
 * the day on show for words that name no day (the model then writes
 * none); whether a later turn's words gave the day; the calendar's own
 * check of the result; and notes shown only when short.
 */
export const tunedReader = (model: LanguageModel): PhraseReader => ({
  change: async ({ draft, referenceDate, said, timeZone, utterance }) => {
    await unavailable(model);
    const shown: TurnDraft = { ...draft, notes: shownNotes(draft.notes) };
    let saidDay = false;
    const result = await tunedTurn(
      model,
      { draft: shown, earlier: said.slice(-SAID_BEFORE), referenceDate, text: utterance },
      {
        adjust: (answer) => {
          saidDay = writesDay(answer);
          return answer;
        },
      },
    );
    if (result.kind !== 'parsed') {
      return result.kind === 'task'
        ? { kind: 'rejected', reason: 'Nothing to change was understood.' }
        : result;
    }
    const invalid = invalidIn(result, timeZone);
    if (invalid !== undefined) {
      return { kind: 'rejected', reason: invalid };
    }
    return saidDay ? { ...result, saidDay: true } : result;
  },
  first: async ({ fallbackDate, phrase, referenceDate, timeZone }) => {
    await unavailable(model);
    // No day written: the day on show, not today. Set before the result
    // is made, so a repeat starts and a night ends from that day.
    const onShow = (answer: unknown): unknown =>
      fallbackDate === undefined ||
      typeof answer !== 'object' ||
      answer === null ||
      writesDay(answer)
        ? answer
        : { ...answer, date: fallbackDate };
    const result = await tunedTurn(
      model,
      { draft: undefined, earlier: [], referenceDate, text: phrase },
      { adjust: onShow },
    );
    if (result.kind === 'rejected') {
      return result;
    }
    const invalid = invalidIn(result, timeZone);
    return invalid === undefined ? result : { kind: 'rejected', reason: invalid };
  },
});
