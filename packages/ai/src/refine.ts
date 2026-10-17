import {
  addDaysToPlainDate,
  daysBetweenPlainDates,
  draftMinutes,
  foldSearchText,
  Temporal,
  validateEventDraft,
} from '@calendar/core';
import {
  type ClockTime,
  clearsRepeat,
  defersDate,
  durationMinutesOf,
  groundDate,
  groundTime,
  isAllDayPhrase,
  isRenamePhrase,
  mentionsDate,
  mentionsRepeat,
  periodOf,
  resolveEnd,
  resolveStart,
  statedTimes,
} from './grounding.ts';
import { inviteesOf, invitesAnyone, readPeople, titleWithoutInvitees } from './invitees.ts';
import { ModelUnavailableError, type LanguageModel } from './model.ts';
import {
  addHour,
  placeOf,
  type QuickAddPrefill,
  type QuickAddResult,
  recurrenceFromParse,
} from './normalizeQuickAdd.ts';
import { QUICK_ADD_JSON_SCHEMA, type QuickAddParse } from './quickAdd.ts';
import { meaningfulText, realDate, realTime, upcomingDays } from './shared.ts';

/** Lower-case, accent-free text with straight apostrophes: what the change's own words are matched against. */
const words = (phrase: string): string =>
  foldSearchText(phrase)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

/**
 * A refinement: the draft as it stands, a sentence about what to change
 * ("make it 7pm", "Thursday instead", "call it team dinner"), and the
 * draft as it should be. Stateless on purpose — the thread keeps the
 * drafts, not a model session — so a turn costs one bounded prompt, works
 * the same over every provider, and the fixture model can play it.
 */

/** The line the current draft follows in the prompt, as one line of JSON. */
export const REFINE_CURRENT_MARKER = 'Current: ';
/** The line the user's words follow in the prompt. */
export const REFINE_CHANGE_MARKER = 'Change: ';

/** The draft a refinement starts from: the prefill as the thread holds it. */
export type RefineDraft = QuickAddPrefill;

export type RefineResult = Exclude<QuickAddResult, { readonly kind: 'task' }>;

export const buildRefinePrompt = ({
  draft,
  referenceDate,
  timeZone,
  utterance,
}: {
  draft: RefineDraft;
  referenceDate: string;
  timeZone: string;
  utterance: string;
}): string =>
  [
    'Here is a calendar event as JSON, and what the user wants changed about',
    'it. Return the whole event with only what they asked for changed; copy',
    'every other field exactly as it is.',
    `Today is ${referenceDate} in time zone ${timeZone}.`,
    'Resolve relative dates ("tomorrow", "next Tuesday") by picking from',
    `this list, never by computing: ${upcomingDays(referenceDate)}.`,
    'Use 24-hour HH:MM times: 1pm is 13:00, 12pm is 12:00, midnight is 00:00.',
    'Never invent a location, a time or a repeat the change does not state,',
    'and never write placeholders like "unknown".',
    `${REFINE_CURRENT_MARKER}${JSON.stringify(draft)}`,
    `${REFINE_CHANGE_MARKER}${utterance}`,
  ].join('\n');

const MINUTES_IN_DAY = 24 * 60;

const minuteOf = (time: string): number => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  return hour * 60 + minute;
};

const format = (total: number): string =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** `start` plus `minutes`, held on the start's day (the editor works on one date). */
const plusMinutes = (start: string, minutes: number): string =>
  format(Math.min(minuteOf(start) + minutes, MINUTES_IN_DAY - 1));

/** A length that moves the event rather than sizing it ("30 minutes later", "eine Stunde früher"). */
const SHIFT = /\b(?:later|earlier|spater|fruher)\b/;

/**
 * An open hour ("at 8") read next to the draft's own start: the reading
 * nearest to it — a dinner at 19:00 moved "to 8" is 20:00, a standup at
 * 09:00 moved "to 8" is 08:00. A meal or part of the day in the words
 * decides instead, and an all-day draft has no start to lean on.
 */
const nearestTo = (stated: ClockTime, anchor: string): string => {
  const [hour = 0, minute = 0] = anchor.split(':').map(Number);
  const target = hour * 60 + minute;
  const options = (stated.hour % 12 === 0 ? [12, 0] : [stated.hour, stated.hour + 12]).map(
    (candidate) => candidate * 60 + stated.minute,
  );
  const best = options.reduce((closest, option) =>
    Math.abs(option - target) < Math.abs(closest - target) ? option : closest,
  );
  return `${String(Math.floor(best / 60)).padStart(2, '0')}:${String(best % 60).padStart(2, '0')}`;
};

/**
 * The start and end the utterance sets, if it sets any. A stated clock
 * time is resolved against the draft (`nearestTo`) rather than the model;
 * a meal or part of the day goes through `groundTime` like a fresh phrase.
 */
const timesOf = (
  utterance: string,
  modelStart: string | undefined,
  draft: RefineDraft,
):
  | { readonly assumed: boolean; readonly endTime?: string; readonly startTime: string }
  | undefined => {
  const { end, start } = statedTimes(utterance);
  const period = periodOf(utterance);
  if (start) {
    const startTime =
      start.exact || period !== undefined || draft.isAllDay
        ? (groundTime(modelStart, utterance).startTime ?? resolveStart(start, period))
        : nearestTo(start, draft.startTime);
    const endTime = end ? resolveEnd(end, startTime) : undefined;
    return { assumed: false, ...(endTime ? { endTime } : {}), startTime };
  }
  const grounded = groundTime(modelStart, utterance);
  return grounded.source === 'period' && grounded.startTime !== undefined
    ? { assumed: true, startTime: grounded.startTime }
    : undefined;
};

/**
 * The refined draft. The model is trusted for the text it extracts (a new
 * title, a new place); the day, the times, the length and the repeat come
 * from the utterance by the same rules as a fresh phrase (`grounding.ts`)
 * and stay as they were when the utterance says nothing about them —
 * whatever the model returned. A moved start keeps the draft's length.
 * The people the words invite or take off the guest list come back
 * beside the draft (`invitees.ts`): its guests are the thread's, not
 * the prefill's.
 */
/** The place taken away ("remove the location", "ohne Ort"). */
const CLEAR_PLACE =
  /\b(?:remove|drop|clear|delete|without|no|ohne|keine?n?|entferne?|losche?)\s+(?:the\s+|den\s+|das\s+|die\s+)?(?:location|place|venue|address|ort|adresse)\b/;

export const normalizeRefine = (
  parse: QuickAddParse,
  {
    draft,
    people,
    referenceDate,
    timeZone,
    utterance,
  }: {
    draft: RefineDraft;
    /** The names the model read as invited or taken off (`readPeople`), held against the words. */
    people?: ReadonlyArray<string> | undefined;
    referenceDate: string;
    timeZone: string;
    utterance: string;
  },
): RefineResult => {
  // Who the words invite or take off the list, held against them.
  const { invite, uninvite } = inviteesOf(people, utterance);
  const guests = {
    ...(invite.length > 0 ? { invite } : {}),
    ...(uninvite.length > 0 ? { uninvite } : {}),
  };
  const named = meaningfulText(parse.title);
  const renamed = named === undefined ? draft.title : titleWithoutInvitees(named, invite);
  // A rename: the new title is all there is (and whom it invites).
  if (isRenamePhrase(utterance)) {
    return { ...guests, kind: 'parsed', prefill: { ...draft, title: renamed } };
  }
  // Words about guests are not about the title: the model wrote the
  // guest into it ("Dinner with Teo and Anna" for "also invite Anna").
  // A "remove" that took no one off ("remove the location") is not.
  const aboutGuests = invite.length > 0 || uninvite.length > 0 || invitesAnyone(utterance);
  const title = aboutGuests ? draft.title : renamed;
  const text = words(utterance);
  // Beside guests, a place only as the words say it: the model made up
  // "Bob's house" for "make it 8pm and invite Bob" (observed).
  const said = meaningfulText(parse.location);
  const place = aboutGuests && said !== undefined && !text.includes(words(said)) ? undefined : said;
  const location = CLEAR_PLACE.test(text)
    ? undefined
    : place === undefined
      ? draft.location
      : placeOf(place, title);

  const modelDate = realDate(parse.date?.trim());
  let date =
    groundDate(modelDate, { phrase: utterance, referenceDate }) ??
    (modelDate !== undefined && (mentionsDate(utterance) || defersDate(utterance))
      ? modelDate
      : draft.date);

  const times = timesOf(utterance, realTime(parse.startTime), draft);
  const length = durationMinutesOf(utterance);
  let isAllDay = draft.isAllDay;
  let startTime = draft.startTime;
  let endTime = draft.endTime;
  let assumedTime = draft.assumedTime === true;
  // Days the form gave a draft that ends on a later day.
  const spanDays =
    draft.endDate === undefined ? 0 : daysBetweenPlainDates(draft.date, draft.endDate);
  // The end day the times below move a spanning draft's end to.
  let spanEnd: string | undefined;
  if (times !== undefined) {
    isAllDay = false;
    startTime = times.startTime;
    if (times.endTime === undefined && spanDays > 0 && !draft.isAllDay) {
      // A moved start keeps a draft over several days its whole length.
      const end = Temporal.PlainDateTime.from(`${date}T${startTime}`).add({
        minutes: Math.max(draftMinutes(draft, 'UTC'), 15),
      });
      endTime = end.toPlainTime().toString({ smallestUnit: 'minute' });
      spanEnd = end.toPlainDate().toString();
    } else {
      // A stated range sets both ends; a moved start keeps the length it had.
      endTime =
        times.endTime ??
        plusMinutes(
          startTime,
          draft.isAllDay ? 60 : Math.max(minuteOf(draft.endTime) - minuteOf(draft.startTime), 15),
        );
    }
    assumedTime = times.assumed;
  } else if (isAllDayPhrase(utterance)) {
    isAllDay = true;
    startTime = '00:00';
    endTime = addHour(startTime);
    assumedTime = false;
  }
  if (length !== undefined && !isAllDay && times?.endTime === undefined) {
    const by = /\b(?:earlier|fruher)\b/.test(text) ? -length : length;
    if (SHIFT.test(text) && spanDays > 0 && times === undefined && !draft.isAllDay) {
      // A draft over several days moves both ends, whole days included.
      const start = Temporal.PlainDateTime.from(`${date}T${startTime}`).add({ minutes: by });
      const end = Temporal.PlainDateTime.from(
        `${addDaysToPlainDate(date, spanDays)}T${endTime}`,
      ).add({ minutes: by });
      date = start.toPlainDate().toString();
      startTime = start.toPlainTime().toString({ smallestUnit: 'minute' });
      endTime = end.toPlainTime().toString({ smallestUnit: 'minute' });
      spanEnd = end.toPlainDate().toString();
    } else if (SHIFT.test(text)) {
      // "30 minutes later": the whole event moves, its length kept.
      const shiftedStart = Math.min(Math.max(minuteOf(startTime) + by, 0), MINUTES_IN_DAY - 1);
      endTime = plusMinutes(format(shiftedStart), minuteOf(endTime) - minuteOf(startTime));
      startTime = format(shiftedStart);
    } else {
      // A stated length sizes the event on its start's day.
      endTime = plusMinutes(startTime, length);
      spanEnd = undefined;
    }
  }
  // A span of days the form gave the draft moves with its start, while
  // the turn leaves its times and kind alone; restated times or a new
  // length read as one day.
  const kept =
    times === undefined && length === undefined && isAllDay === draft.isAllDay ? spanDays : 0;
  const endDate =
    spanEnd !== undefined
      ? spanEnd === date
        ? undefined
        : spanEnd
      : kept > 0
        ? addDaysToPlainDate(date, kept)
        : undefined;
  if (!isAllDay && endDate === undefined && endTime <= startTime) {
    return { kind: 'rejected', reason: 'That would end after midnight — pick an earlier time.' };
  }

  const fields = {
    calendarKey: 'placeholder:placeholder',
    date,
    endDate,
    endTime,
    isAllDay,
    startTime,
    title,
  };
  const invalid = validateEventDraft(fields, timeZone);
  if (invalid) {
    return { kind: 'rejected', reason: invalid };
  }

  const parsedRepeat = mentionsRepeat(utterance)
    ? recurrenceFromParse(parse.recurrence, date)
    : undefined;
  // A changed repeat keeps the weekdays the editor chose while the
  // frequency stays the same ("every two weeks" on Mondays and Wednesdays).
  const keptDays =
    parsedRepeat && draft.recurrence?.byDay && draft.recurrence.freq === parsedRepeat.freq
      ? { byDay: draft.recurrence.byDay }
      : {};
  const recurrence = clearsRepeat(utterance)
    ? undefined
    : parsedRepeat
      ? { ...parsedRepeat, ...keptDays }
      : draft.recurrence;

  return {
    ...guests,
    kind: 'parsed',
    prefill: {
      ...(assumedTime ? { assumedTime } : {}),
      date,
      ...(endDate === undefined ? {} : { endDate }),
      endTime,
      isAllDay,
      ...(location ? { location } : {}),
      ...(recurrence ? { recurrence } : {}),
      startTime,
      title,
    },
  };
};

/**
 * One change to one draft. Only the model call is impure; the prompt and
 * the merge either side of it are pure, so this runs end to end against
 * a fake model like `parseQuickAdd`.
 */
export const parseRefine = async (
  model: LanguageModel,
  {
    draft,
    referenceDate,
    timeZone,
    utterance,
  }: { draft: RefineDraft; referenceDate: string; timeZone: string; utterance: string },
): Promise<RefineResult> => {
  if (!utterance.trim()) {
    return { kind: 'rejected', reason: 'Say what to change.' };
  }
  if ((await model.status()) !== 'ready') {
    throw new ModelUnavailableError({ message: 'No on-device model is available.' });
  }
  let raw: unknown;
  const people = readPeople(model, utterance, { removals: true });
  try {
    raw = await model.generateJson({
      jsonSchema: QUICK_ADD_JSON_SCHEMA,
      prompt: buildRefinePrompt({ draft, referenceDate, timeZone, utterance }),
    });
  } catch {
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { kind: 'rejected', reason: "That couldn't be read — try rephrasing." };
  }
  return normalizeRefine(raw as QuickAddParse, {
    draft,
    people: await people,
    referenceDate,
    timeZone,
    utterance,
  });
};
