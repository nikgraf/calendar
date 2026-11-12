import {
  type ChangeLabels,
  draftChanges,
  type FieldChange,
  fieldName,
  type StepField,
} from './draftChanges.ts';
import { type DraftThreadState, type Pick, type StepLine, threadLine } from './draftThread.ts';

/**
 * A thread's steps as the editors draw them: what a step did to a draft
 * in words, what the step on show marks in the form, and how a step is
 * named where there is one line for it. Pure, so the apps only lay it out.
 */

/**
 * What a step did to one of its drafts, field by field — the draft named,
 * else the one the form showed once the step had landed. A draft the step
 * made has every field it holds; a draft the step left alone has none.
 */
export const lineChanges = (
  line: StepLine,
  draftId?: string,
  labels?: ChangeLabels,
): ReadonlyArray<FieldChange> => {
  const after =
    draftId === undefined
      ? line.after.drafts[line.after.focused]
      : line.after.drafts.find((draft) => draft.id === draftId);
  return after === undefined
    ? []
    : draftChanges(
        line.before.drafts.find((draft) => draft.id === after.id),
        after,
        labels,
      );
};

/** The fields the step on show changed: what the form and the card mark, and under which step's id. */
export interface StepMarks {
  readonly changes: ReadonlyArray<FieldChange>;
  readonly fields: ReadonlySet<StepField>;
  /** The step's id: another step is another set of marks. */
  readonly key: string;
}

/**
 * What the form marks: the fields the step on show changed on the draft
 * it shows, kept until another step is shown. Nothing before the first
 * step — and nothing for an edit made by hand that is the newest step:
 * a field need not light up under the hand that is typing in it. Shown
 * again later, as an older step, it is marked like any other.
 */
export const shownMarks = (state: DraftThreadState, labels?: ChangeLabels): StepMarks | null => {
  const shown = threadLine(state)[state.steps.length - 1];
  if (shown === undefined || (shown.step.kind === 'edit' && state.ahead.length === 0)) {
    return null;
  }
  const changes = lineChanges(shown, state.drafts[state.focused]?.id, labels);
  return {
    changes,
    fields: new Set(changes.map((change) => change.field)),
    key: shown.step.id,
  };
};

const PICKED: Record<Pick, string> = {
  guest: 'Guest picked',
  place: 'Place picked',
  slot: 'Free slot picked',
};

/** How a step came about: said (or typed) to the assistant, or done by hand. */
export const stepSource = (line: StepLine): 'By hand' | 'Said' =>
  line.step.kind === 'phrase' ? 'Said' : 'By hand';

/** A step in one line: the words said, the fields edited by hand, or what was picked. */
export const stepName = (line: StepLine): string => {
  const { step } = line;
  switch (step.kind) {
    case 'edit':
      return step.fields.map(fieldName).join(', ');
    case 'phrase':
      return `“${step.utterance}”`;
    case 'pick':
      return PICKED[step.pick];
  }
};
