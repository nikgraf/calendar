import { buildFindTimePrompt, FIND_TIME_JSON_SCHEMA } from '@calendar/ai';

/**
 * The app's finder prompt as the teacher is asked it, with one line
 * changed: a length only where the words give one. The app's own asks for
 * a length always (its schema requires one); the Assistant's model is to
 * leave it out, so the finder searches for its own.
 */
const LENGTH_REQUIRED = 'durationMinutes is required: "90 min" is 90';
const LENGTH_WHEN_SAID = 'durationMinutes only when the phrase says how long: "90 min" is 90';

export const buildFinderLabelPrompt = (input: {
  readonly phrase: string;
  readonly referenceDate: string;
  readonly timeZone: string;
}): string => {
  const prompt = buildFindTimePrompt(input);
  if (!prompt.includes(LENGTH_REQUIRED)) {
    throw new Error("the app's finder prompt changed: update buildFinderLabelPrompt");
  }
  return prompt.replace(LENGTH_REQUIRED, LENGTH_WHEN_SAID);
};

/** The app's finder schema without its required length. */
export const FINDER_LABEL_SCHEMA = { ...FIND_TIME_JSON_SCHEMA, required: [] };
