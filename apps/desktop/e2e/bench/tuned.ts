import {
  type LanguageModel,
  type QuickAddResult,
  type RefineResult,
  tunedAnswer,
  tunedPrompt as turnPrompt,
  tunedTurn as turnOf,
} from '@calendar/ai';
import type { BenchDraft } from './check.ts';
import { turnDraftOf } from './plain.ts';

export {
  buildTunedPrompt,
  buildTunedRefinePrompt,
  shortDraft,
  TUNED_CHANGE_MARKER,
  TUNED_DRAFT_MARKER,
  TUNED_PHRASE_MARKER,
  tunedAnswer,
} from '@calendar/ai';

/**
 * The tuned arm of the bench: the app's tuned path (`tuned.ts` in
 * `@calendar/ai`) over the bench's drafts. A model trained for this one
 * job, asked without the conventions. The prompt is the days, the draft where there
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

interface TunedTurn {
  readonly draft: BenchDraft | undefined;
  readonly earlier: ReadonlyArray<string>;
  readonly referenceDate: string;
  readonly text: string;
}

/** The prompt of a turn, or undefined where the draft is nothing a turn can change. */
export const tunedPrompt = (turn: TunedTurn): string | undefined => {
  if (turn.draft === undefined) {
    return turnPrompt({ ...turn, draft: undefined });
  }
  const draft = turnDraftOf(turn.draft);
  return draft === undefined ? undefined : turnPrompt({ ...turn, draft });
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

/** One turn through the tuned arm: the first phrase, or a change to the draft. */
export const tunedTurn = async (
  model: LanguageModel,
  turn: TunedTurn,
): Promise<QuickAddResult | RefineResult> => {
  const draft = turn.draft === undefined ? undefined : turnDraftOf(turn.draft);
  if (turn.draft !== undefined && draft === undefined && turn.text.trim()) {
    return { kind: 'rejected', reason: 'not an event' };
  }
  return turnOf(model, { ...turn, draft });
};
