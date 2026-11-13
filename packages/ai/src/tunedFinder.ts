import {
  type FindTimeParse,
  type FindTimeResult,
  normalizeFindTime,
  parseFindTime,
} from './findTime.ts';
import { type LanguageModel, ModelUnavailableError } from './model.ts';
import { upcomingDays } from './shared.ts';
import { TUNED_PHRASE_MARKER } from './tuned.ts';

/**
 * Find a time on the Assistant's own model: the same model as the
 * Assistant (`tuned.ts`), told the job by the prompt's first line. The
 * prompt is that line, the days and the sentence; the answer is the
 * finder's fields the words state, written short, the window's days
 * looked up in the days shown. No word rule reads the sentence: what the
 * answer leaves out is the code's default (the coming week, the finder's
 * own length). The prompt's bytes are the ones the model was trained on:
 * a change here needs a model trained again.
 */

export const TUNED_FINDER_LINE = 'Free time as JSON.';

/** What a finder asks for: one sentence, and the length to search for when it says none. */
export interface FinderInput {
  /** The finder's current length, searched for when the sentence does not say how long. */
  readonly fallbackDurationMinutes?: number | undefined;
  readonly phrase: string;
  readonly referenceDate: string;
  readonly timeZone: string;
}

/** How find a time reads a sentence: the Assistant's model, or another with the word rules. */
export type FinderReader = (input: FinderInput) => Promise<FindTimeResult>;

export const buildTunedFinderPrompt = ({
  phrase,
  referenceDate,
}: {
  readonly phrase: string;
  readonly referenceDate: string;
}): string =>
  [
    TUNED_FINDER_LINE,
    `Days: ${upcomingDays(referenceDate)}`,
    `${TUNED_PHRASE_MARKER}${phrase}`,
  ].join('\n');

/** The order the finder's answer is written in. */
const FINDER_ORDER = [
  'durationMinutes',
  'windowStartDate',
  'windowEndDate',
  'daysOfWeek',
  'earliestTime',
  'latestTime',
  'title',
] as const;

const isBlank = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (typeof value === 'string' && value.trim() === '') ||
  (Array.isArray(value) && value.length === 0);

/**
 * A finder answer as the tuned model is trained to write it: the fields
 * it has, in one order, empty ones left out. Undefined for an answer that
 * is no object.
 */
export const tunedFinderAnswer = (answer: unknown): Record<string, unknown> | undefined => {
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return undefined;
  }
  const record = answer as Record<string, unknown>;
  return Object.fromEntries(
    FINDER_ORDER.flatMap((key) => (isBlank(record[key]) ? [] : [[key, record[key]]])),
  );
};

const REFUSED = "That couldn't be read — try rephrasing.";

/** One sentence through the Assistant's model, its answer read without the word rules. */
export const tunedFindTime = async (
  model: LanguageModel,
  { fallbackDurationMinutes, phrase, referenceDate }: FinderInput,
): Promise<FindTimeResult> => {
  if (!phrase.trim()) {
    return { kind: 'rejected', reason: 'Describe the time you need.' };
  }
  if ((await model.status()) !== 'ready') {
    throw new ModelUnavailableError({ message: "The Assistant's model is not ready." });
  }
  let answer: unknown;
  try {
    // No schema, as for the Assistant: the model learnt the short form.
    answer = await model.generateJson({
      jsonSchema: undefined,
      prompt: buildTunedFinderPrompt({ phrase, referenceDate }),
    });
  } catch {
    return { kind: 'rejected', reason: REFUSED };
  }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    return { kind: 'rejected', reason: REFUSED };
  }
  return normalizeFindTime(answer as FindTimeParse, { fallbackDurationMinutes, referenceDate });
};

/** Find a time on the Assistant's own model. */
export const tunedFinder =
  (model: LanguageModel): FinderReader =>
  (input) =>
    tunedFindTime(model, input);

/** Find a time on Apple's or a served model, held to the words by the rules (`grounding.ts`). */
export const rulesFinder =
  (model: LanguageModel): FinderReader =>
  (input) =>
    parseFindTime(model, input);
