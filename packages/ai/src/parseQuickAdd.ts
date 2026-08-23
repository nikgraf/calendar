import { ModelUnavailableError, type LanguageModel } from './model.ts';
import { normalizeQuickAdd, type QuickAddResult } from './normalizeQuickAdd.ts';
import { buildQuickAddPrompt, QUICK_ADD_JSON_SCHEMA, type QuickAddParse } from './quickAdd.ts';

/**
 * One phrase in, an editor prefill out. The only impure step is the model
 * call; prompt building and normalization either side of it are pure, so
 * this is testable end to end with a fake model.
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
  if ((await model.status()) !== 'ready') {
    throw new ModelUnavailableError('No on-device model is available.');
  }

  let raw: unknown;
  try {
    raw = await model.generateJson({
      jsonSchema: QUICK_ADD_JSON_SCHEMA,
      prompt: buildQuickAddPrompt({ phrase, referenceDate, timeZone }),
    });
  } catch {
    // A model that errors or times out must not lose what the user typed.
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  return normalizeQuickAdd(raw as QuickAddParse, { fallbackDate, referenceDate, timeZone });
};
