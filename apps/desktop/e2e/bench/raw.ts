import {
  buildQuickAddPrompt,
  buildRefinePrompt,
  type LanguageModel,
  normalizeQuickAdd,
  QUICK_ADD_JSON_SCHEMA,
  type QuickAddParse,
  type QuickAddResult,
  type RefineResult,
} from '@calendar/ai';
import { convertQuickAddItem } from '@calendar/app-state/quickAddItem';
import type { BenchDraft } from './check.ts';

/**
 * The raw arm of the bench: the app's own prompts, and the model's answer
 * as it came. The answer is validated (a real date, a real time, an end
 * after its start) but never held against the words, the way capture
 * takes it: no grounding of the day, the times, the title or the place,
 * no to-do cue, no people question, no notes or notifications read from
 * the phrase. Beside the app's pipeline it says what the grounding buys
 * on a model; the plain arm (`plain.ts`) asks a different prompt.
 */

const REFUSED = "That couldn't be read — try rephrasing.";

export const rawTurn = async (
  model: LanguageModel,
  {
    draft,
    referenceDate,
    text,
    timeZone,
  }: {
    readonly draft: BenchDraft | undefined;
    readonly referenceDate: string;
    readonly text: string;
    readonly timeZone: string;
  },
): Promise<QuickAddResult | RefineResult> => {
  if (!text.trim()) {
    return { kind: 'rejected', reason: 'Type what you want to schedule.' };
  }
  const asEvent = draft === undefined ? undefined : convertQuickAddItem(draft.item, 'event');
  const before = asEvent?.kind === 'event' ? asEvent.prefill : undefined;
  if (draft !== undefined && before === undefined) {
    return { kind: 'rejected', reason: 'not an event' };
  }
  const prompt =
    before === undefined
      ? buildQuickAddPrompt({ phrase: text, referenceDate, timeZone })
      : buildRefinePrompt({ draft: before, referenceDate, timeZone, utterance: text });
  let answer: unknown;
  try {
    answer = await model.generateJson({ jsonSchema: QUICK_ADD_JSON_SCHEMA, prompt });
  } catch {
    return { kind: 'rejected', reason: REFUSED };
  }
  if (typeof answer !== 'object' || answer === null) {
    return { kind: 'rejected', reason: REFUSED };
  }
  // No phrase: the normalizer validates the answer and lets it stand.
  return normalizeQuickAdd(answer as QuickAddParse, {
    fallbackDate: before?.date,
    referenceDate,
    timeZone,
  });
};
