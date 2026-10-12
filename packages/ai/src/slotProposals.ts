import {
  type BackendClient,
  type EventRecord,
  foldSearchText,
  type FreeSlot,
  rankSlotsAround,
} from '@calendar/core';
import { parseFindTime } from './findTime.ts';
import { findSlotsFor } from './findTimePipeline.ts';
import { isRenamePhrase, periodOf } from './grounding.ts';
import type { LanguageModel } from './model.ts';

/**
 * Slot proposals in the create thread: a phrase that asks for free time
 * ("find 90 min for focus next week, mornings") is routed to the finder
 * prompt instead of quick-add, the free slots it finds are ranked for the
 * time of day it names, and the thread takes the best as the draft with
 * the rest offered beside it. The router is code, so the two prompts stay
 * tuned apart and a phrase never has to say which it is.
 */

/** How many slots a proposal offers: the chosen one and a handful beside it, a chip row's worth. */
export const MAX_SLOT_PROPOSALS = 6;

/** More than the row shows, so the best of a week's mornings is among them before ranking. */
const SOLVER_SLOTS = 24;

/** The solver's own daytime, the bounds a phrase without any searches. */
const DEFAULT_EARLIEST = '08:00';
const DEFAULT_LATEST = '20:00';
/** 23:59, the last minute a wall-clock time can name. */
const LAST_MINUTE = 23 * 60 + 59;

/** Lower-case, accent-free text with straight apostrophes: what the cues are matched against. */
const words = (phrase: string): string =>
  foldSearchText(phrase)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

/**
 * The ways English and German ask for free time rather than name an
 * event. Each cue needs a search verb or question beside a time word, so
 * "Free lunch Friday", "Fitness class at 7", "Opening night" and
 * "Finders Keepers screening" stay quick-add phrases.
 */
const FINDER_CUES: ReadonlyArray<RegExp> = [
  // "find (me) (a/some) 90 min / 1h / time / a slot / an hour …" — up to three words between.
  /\bfind(?:s|ing)? (?:me |us )?(?:a |an |some |the )?(?:\S+ ){0,3}?(?:time|slot|gap|hour|hours|window|opening|spot|moment|minutes?|mins?|h|\d+(?:h|hrs?|min(?:ute)?s?))\b/,
  /\b(?:look|looking|search|searching) for (?:a |an |some )?(?:free |open |quiet )?(?:time|slot|gap|hour|window|opening|spot)\b/,
  // "when can I …", "when am I free", "when do we have time"
  /\bwhen (?:can|could|do|does|would|should|am|are|will|might) (?:i|we)\b/,
  /\bwhere can (?:i|we) fit\b/,
  // "a free slot", "free time", "a free afternoon"
  /\bfree (?:time|slot|hour|hours|spot|gap|window|moment|morning|afternoon|evening|day)\b/,
  // "fit in a walk", "fit a visit in", "fit 45 min"
  /\bfit (?:in\b|a\b|an\b|some\b|\d)|\bfit\b.*\bin\b/,
  /\bsometime\b|\bany (?:openings?|availability)\b|\ban opening for\b/,
  // German
  /\bfinde?(?:n|t|st)? (?:mir |uns )?(?:\S+ ){0,3}?(?:zeit|termin|slot|lucke|platz|fenster|zeitfenster|stunden?|minuten|min|\d+(?:h|min|std))\b/,
  /\b(?:zeit|termin|lucke|slot|platz) (?:finden|suchen)\b/,
  // "wann habe ich Zeit", "wann kann ich", "wann passt", "wo passt … rein"
  /\bwann (?:habe?|hab|kann|konnte|konnen|konnten|passt|ware|hatte|hatten|bin|sind|soll|sollte|geht|ginge)\b/,
  /\bwo passt\b|\bpasst\b.*\brein\b|\breinpassen\b|\bunterbringen\b|\bdazwischen\b/,
  /\bfreie[nrs]? (?:zeit|slot|termin|stunde|stunden|platz|lucke|vormittag|nachmittag|abend|tag)\b/,
  /\bfrei (?:habe|hab|bin|sind|haben)\b/,
  /\blucke\b|\bzeitfenster\b|\birgendwann\b/,
];

/**
 * Whether a phrase asks for free time ("find 90 min for focus next week",
 * "when can I fit a call with Anna", "wann habe ich Zeit für …") rather
 * than describing an event. Read by the code, never the model: a finder
 * sentence goes to the finder prompt, every other phrase to quick-add or
 * the refinement. A rename is never one — "call it Free time" names the
 * event, whatever the name says.
 */
export const isFinderPhrase = (phrase: string): boolean => {
  if (isRenamePhrase(phrase)) {
    return false;
  }
  const text = words(phrase);
  return FINDER_CUES.some((cue) => cue.test(text));
};

/** Minutes since midnight as `HH:MM`. */
const format = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

const minuteOf = (time: string): number => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
};

/**
 * The time of day the proposals lean to, when the phrase names a meal or
 * a part of the day: the middle of the daily bounds the finder settled on
 * — the period's own window as a rule ("mornings" → 10:00, "lunch" →
 * 12:45), the model's where the words made the period a boundary ("after
 * dinner"). Undefined when the phrase names none: the slots then stay in
 * the solver's order, soonest first.
 */
export const proposalCentre = (
  phrase: string,
  bounds: { readonly earliestTime?: string | undefined; readonly latestTime?: string | undefined },
): string | undefined => {
  if (periodOf(phrase) === undefined) {
    return undefined;
  }
  const earliest = minuteOf(bounds.earliestTime ?? DEFAULT_EARLIEST);
  const latest = minuteOf(bounds.latestTime ?? DEFAULT_LATEST);
  // The exact middle minute, never past the day's last one: the solver
  // rounds the slot it places to the quarter hour itself, and a centre of
  // "24:00" (a 23:50–23:59 window) is no clock time it can place.
  return format(Math.min(Math.floor((earliest + latest) / 2), LAST_MINUTE));
};

export type SlotProposalResult =
  | {
      readonly kind: 'proposed';
      /** Best first: the thread's draft, then the alternatives. At least one. */
      readonly slots: ReadonlyArray<FreeSlot>;
      /** What the time is for, when the phrase said. */
      readonly title?: string | undefined;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

export const NO_SLOT_FITS = 'No free slot fits — try another window or a shorter one.';

/**
 * A finder phrase, start to finish: the finder prompt reads it into
 * constraints (the normalizer holding them to the phrase), the solver
 * lists the free slots with each gap's slot placed at the named time of
 * day, and the ranking puts the slot nearest that time first. Only the
 * model call and the event read are impure.
 */
export const proposeSlots = async (
  model: LanguageModel,
  backend: BackendClient,
  {
    exclude,
    fallbackDurationMinutes,
    phrase,
    referenceDate,
    timeZone,
  }: {
    /** Rows that are not busy time: the draft's own event when it is being rescheduled. */
    readonly exclude?: ((event: EventRecord) => boolean) | undefined;
    /** Searched for when the phrase does not say how long: the draft's own length. */
    readonly fallbackDurationMinutes?: number | undefined;
    readonly phrase: string;
    readonly referenceDate: string;
    readonly timeZone: string;
  },
): Promise<SlotProposalResult> => {
  const parsed = await parseFindTime(model, {
    fallbackDurationMinutes,
    phrase,
    referenceDate,
    timeZone,
  });
  if (parsed.kind === 'rejected') {
    return parsed;
  }
  const centre = proposalCentre(phrase, parsed.constraints);
  const found = await findSlotsFor(backend, parsed.constraints, timeZone, {
    exclude,
    maxSlots: SOLVER_SLOTS,
    preferredTime: centre,
  });
  if ('reason' in found) {
    return { kind: 'rejected', reason: found.reason };
  }
  const slots = rankSlotsAround(found, centre).slice(0, MAX_SLOT_PROPOSALS);
  if (slots.length === 0) {
    return { kind: 'rejected', reason: NO_SLOT_FITS };
  }
  return {
    kind: 'proposed',
    slots,
    ...(parsed.title === undefined ? {} : { title: parsed.title }),
  };
};
