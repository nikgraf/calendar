import { readExtras } from './extras.ts';
import { readPeople } from './invitees.ts';
import { ModelUnavailableError, type LanguageModel } from './model.ts';
import { normalizeQuickAdd, type QuickAddResult, withExtras } from './normalizeQuickAdd.ts';
import { buildQuickAddPrompt, QUICK_ADD_JSON_SCHEMA, type QuickAddParse } from './quickAdd.ts';

/**
 * One phrase in, an editor prefill out. The only impure step is the model
 * call; prompt building and normalization either side of it are pure, so
 * this is testable end to end with a fake model. The normalizer gets the
 * phrase too: the model's answer is held against the words it came from.
 * What the phrase says beside the event — a note, notifications — is read
 * first and taken off the words (`extras.ts`), so the model and the
 * grounding see the event alone.
 */
export const parseQuickAdd = async (
  model: LanguageModel,
  {
    fallbackDate,
    phrase,
    referenceDate,
    timeZone,
  }: {
    /** Day to use when the phrase states none — usually the focused day. */
    fallbackDate?: string | undefined;
    phrase: string;
    referenceDate: string;
    timeZone: string;
  },
): Promise<QuickAddResult> => {
  if (!phrase.trim()) {
    return { kind: 'rejected', reason: 'Type what you want to schedule.' };
  }
  const extras = readExtras(phrase);
  const words = extras.rest;
  if (!words.trim()) {
    // A note or a notification alone: there is no event for it yet.
    return { kind: 'rejected', reason: 'Say what to schedule first.' };
  }
  if ((await model.status()) !== 'ready') {
    throw new ModelUnavailableError({ message: 'No on-device model is available.' });
  }

  let raw: unknown;
  // Who the phrase invites is a question of its own, asked beside the
  // extraction and only when the words hold an invitation cue.
  const people = readPeople(model, words, { removals: false });
  try {
    raw = await model.generateJson({
      jsonSchema: QUICK_ADD_JSON_SCHEMA,
      prompt: buildQuickAddPrompt({ phrase: words, referenceDate, timeZone }),
    });
  } catch {
    // A model that errors or times out must not lose what the user typed.
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  return withExtras(
    normalizeQuickAdd(raw as QuickAddParse, {
      fallbackDate,
      people: await people,
      phrase: words,
      referenceDate,
      timeZone,
    }),
    extras,
  );
};
