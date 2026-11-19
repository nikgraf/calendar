import {
  type ChangeLabels,
  draftChanges,
  type FieldChange,
  fieldName,
  guestsOf,
  type StepField,
} from './draftChanges.ts';
import { guestLabel } from './draftInvitees.ts';
import {
  type Draft,
  type DraftThreadState,
  type NoChangeTurn,
  type PickKind,
  type StepLine,
  threadLine,
} from './draftThread.ts';

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

/**
 * The focused draft as it was before the step on show, when that step
 * changed its day or hours — where the calendar outlines that it stood
 * (`threadPreviews`). Under the same rule as the marks: not for an edit
 * by hand at the tip.
 */
export const movedFrom = (state: DraftThreadState, marks: StepMarks | null): Draft | undefined => {
  if (marks === null || !(marks.fields.has('date') || marks.fields.has('time'))) {
    return undefined;
  }
  const focused = state.drafts[state.focused]?.id;
  return threadLine(state)[state.steps.length - 1]?.before.drafts.find(
    (draft) => draft.id === focused,
  );
};

const PICKED: Record<PickKind, string> = {
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

/** A step's row among the versions: which one it left, and that a hand made it. */
export const versionLabel = (line: StepLine): string =>
  `Version ${String(line.position)}${line.step.kind === 'phrase' ? '' : ' · by hand'}`;

/**
 * What a changed field reads now, in a row. Guests go by name, as a
 * phrase's own summary names them: the row is one line, and a card
 * shows their addresses.
 */
const rowValue = (change: FieldChange, draft: Draft | undefined): string =>
  change.field === 'guests'
    ? guestsOf(draft).map(guestLabel).join(', ') || 'none'
    : (change.to ?? 'none');

/**
 * What a step did, in the one line of its row: a phrase's own summary,
 * else the fields changed by hand with what they read now.
 */
export const stepSummary = (line: StepLine, labels?: ChangeLabels): string => {
  if (line.step.kind === 'phrase') {
    return line.step.summary;
  }
  const changes = lineChanges(line, undefined, labels);
  const shown = line.after.drafts[line.after.focused];
  return changes.length === 0
    ? stepName(line)
    : changes.map((change) => `${fieldName(change.field)}: ${rowValue(change, shown)}`).join(' · ');
};

/** What a card says its step changed, under the fields: "Changed: time, guests", or nothing. */
export const changedLine = (changes: ReadonlyArray<FieldChange>): string =>
  changes.length === 0
    ? ''
    : `Changed: ${changes.map((change) => fieldName(change.field).toLowerCase()).join(', ')}`;

/** Words that changed nothing, as the conversation lists them after the step they followed. */
export interface NoChangeLine {
  /**
   * Something came after them — a step, other words — or an older step
   * is on show: they are history, and their other readings are no longer
   * offered.
   */
  readonly dimmed: boolean;
  readonly turn: NoChangeTurn;
}

/**
 * The words that changed nothing, by the position of the step they
 * follow (`StepLine.position`; 0 before the first), oldest first. Only
 * the newest of all is undimmed, while no step came after it, no older
 * step is on show and the draft it was said to is the one in the form:
 * its readings would be said to that one.
 */
export const noChangeLines = (
  state: DraftThreadState,
): ReadonlyMap<number, ReadonlyArray<NoChangeLine>> => {
  const line = [...state.steps, ...state.ahead.map(({ step }) => step)];
  const positionOf = (turn: NoChangeTurn): number =>
    turn.after === undefined ? 0 : line.findIndex((step) => step.id === turn.after) + 1;
  const last = state.noChange.at(-1);
  const focused = state.drafts[state.focused]?.id;
  const live =
    last !== undefined &&
    state.ahead.length === 0 &&
    positionOf(last) === line.length &&
    (last.draft === undefined || last.draft === focused)
      ? last
      : undefined;
  const lines = new Map<number, ReadonlyArray<NoChangeLine>>();
  for (const turn of state.noChange) {
    const position = positionOf(turn);
    lines.set(position, [...(lines.get(position) ?? []), { dimmed: turn !== live, turn }]);
  }
  return lines;
};
