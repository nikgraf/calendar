import { type Contact, type PlaceCandidate, preselectedPlace } from '@calendar/core';
import { choiceQuestion, type InviteeChoice } from './draftInvitees.ts';
import type { PlaceChoice } from './draftPlaces.ts';

/**
 * What the Assistant asks about a draft, one at a time under its newest
 * card: something with a real choice to make. A place the words could
 * mean in more than one way, or that nothing they said resembled; a name
 * that found contacts but no one for sure. Not asked, shown as a row of
 * their own: a lone place that was taken (the text as said stays a tap
 * away), and a name nobody in the contacts has (a note).
 */
export type DraftQuestion =
  | { readonly choice: PlaceChoice; readonly kind: 'place' }
  | { readonly choice: InviteeChoice; readonly kind: 'guest' };

/** The questions asked, the one on show and its place among them. */
export interface QuestionsAsked {
  /** The one asked now, or none left. */
  readonly current: DraftQuestion | undefined;
  /** Its number, counted from 1 among all asked since they came. */
  readonly number: number;
  /** How many were asked together: "Question 1 of 2". */
  readonly of: number;
}

/** A place choice is a question unless it holds one place and that one was taken. */
export const isPlaceQuestion = (choice: PlaceChoice): boolean =>
  choice.candidates.length > 1 || preselectedPlace(choice.candidates) === undefined;

/** A name is a question when it found someone to pick; with nobody it is a note. */
export const isGuestQuestion = (choice: InviteeChoice): boolean => choice.contacts.length > 0;

/**
 * The questions open, in the order they are asked: the place first, then
 * the names in the order they were said.
 */
export const openQuestions = (
  place: PlaceChoice | undefined,
  guests: ReadonlyArray<InviteeChoice>,
): ReadonlyArray<DraftQuestion> => [
  ...(place !== undefined && isPlaceQuestion(place)
    ? [{ choice: place, kind: 'place' } as const]
    : []),
  ...guests.filter(isGuestQuestion).map((choice) => ({ choice, kind: 'guest' }) as const),
];

/**
 * The questions a turn asked together, by kind: the editor counts only
 * those it can ask (no names on a calendar that cannot invite).
 */
export interface Asked {
  readonly guests: number;
  readonly places: number;
}

/**
 * The first open question and where it stands: "Question 2 of 2" after
 * one was answered, not "1 of 1". `asked` is how many came together (a
 * draft's `asked`, the names counted only when `guests` are asked);
 * fewer open means the rest were answered, skipped or left behind by an
 * edit. More open than asked (an older draft, or one the count never
 * reached) counts the open ones.
 */
export const questionsAsked = (
  asked: Asked | undefined,
  open: ReadonlyArray<DraftQuestion>,
  { guests = true }: { readonly guests?: boolean } = {},
): QuestionsAsked => {
  const count = asked === undefined ? 0 : asked.places + (guests ? asked.guests : 0);
  const of = Math.max(count, open.length);
  return { current: open[0], number: of - open.length + 1, of };
};

/**
 * What the editor asks about its draft: the place its field still reads
 * (`livePlace`) — or, while the form is still taking a turn in (its field
 * reads the draft before, and the count would show the next question
 * first for a frame), the event draft's own — then the names, counted
 * only where the calendar can invite (`guests` is empty there).
 */
export const editorQuestions = ({
  applying,
  asked,
  canInvite,
  draftPlace,
  event,
  guests,
  livePlace,
}: {
  readonly applying: boolean;
  readonly asked: Asked | undefined;
  readonly canInvite: boolean;
  readonly draftPlace: PlaceChoice | undefined;
  readonly event: boolean;
  readonly guests: ReadonlyArray<InviteeChoice>;
  readonly livePlace: PlaceChoice | undefined;
}): QuestionsAsked =>
  questionsAsked(asked, openQuestions(applying && event ? draftPlace : livePlace, guests), {
    guests: canInvite,
  });

/**
 * A draft's own questions, as its state holds them (the editor narrows
 * the place to the one the form still reads, `livePlaceChoice`).
 */
const questionsOf = (draft: {
  readonly inviteeChoices?: ReadonlyArray<InviteeChoice> | undefined;
  readonly placeChoice?: PlaceChoice | undefined;
}): ReadonlyArray<DraftQuestion> => openQuestions(draft.placeChoice, draft.inviteeChoices ?? []);

/**
 * How many questions a draft has asked, after a turn: when the turn
 * brought one that was not open before (a new place, a new name), the
 * count starts again from what is open now; otherwise it stays — a
 * phrase about the time leaves "Question 2 of 2" where it was. A choice
 * is told by identity: a turn that keeps one keeps the same object.
 */
export const askedAfterTurn = (
  before:
    | {
        readonly asked?: Asked | undefined;
        readonly inviteeChoices?: ReadonlyArray<InviteeChoice> | undefined;
        readonly placeChoice?: PlaceChoice | undefined;
      }
    | undefined,
  after: {
    readonly inviteeChoices?: ReadonlyArray<InviteeChoice> | undefined;
    readonly placeChoice?: PlaceChoice | undefined;
  },
): Asked | undefined => {
  const now = questionsOf(after);
  const brought = now.some((question) =>
    question.kind === 'place'
      ? question.choice !== before?.placeChoice
      : !(before?.inviteeChoices ?? []).includes(question.choice),
  );
  if (now.length === 0) {
    return undefined;
  }
  const places = now.filter((question) => question.kind === 'place').length;
  return brought ? { guests: now.length - places, places } : before?.asked;
};

/** What the card asks: "Which place for “Figlmüller”?", "Which Tom?". */
export const questionText = (question: DraftQuestion): string =>
  question.kind === 'place'
    ? `Which place for “${question.choice.text}”?`
    : choiceQuestion(question.choice);

/** "Question 2 of 2". */
export const questionCount = ({ number, of }: QuestionsAsked): string =>
  `Question ${String(number)} of ${String(of)}`;

/** An answer as a row shows it: what it is, and what tells it from the others. */
export interface OptionLabel {
  readonly detail: string;
  readonly title: string;
}

/** A place: a past one by its text, a search hit by its name over its address. */
export const placeOption = (candidate: PlaceCandidate): OptionLabel =>
  candidate.source === 'history'
    ? { detail: 'A place you used before', title: candidate.geo.source }
    : { detail: candidate.address ?? '', title: candidate.geo.name ?? candidate.geo.source };

/** The text as said, kept: no place on the map. */
export const asSaidOption = (choice: PlaceChoice): OptionLabel => ({
  detail: 'As said, no place on the map',
  title: `Just “${choice.text}”`,
});

/** A contact: by name over its address (two Toms differ by the address). */
export const contactOption = (contact: Contact): OptionLabel =>
  contact.displayName === undefined
    ? { detail: '', title: contact.email }
    : { detail: contact.email, title: contact.displayName };
