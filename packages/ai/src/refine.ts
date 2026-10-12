import { validateEventDraft } from '@calendar/core';
import {
  type ClockTime,
  clearsRepeat,
  durationMinutesOf,
  groundDate,
  groundTime,
  isAllDayPhrase,
  mentionsDate,
  mentionsRepeat,
  periodOf,
  resolveEnd,
  resolveStart,
  statedTimes,
} from './grounding.ts';
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

/** `start` plus `minutes`, held on the start's day (the editor works on one date). */
const plusMinutes = (start: string, minutes: number): string => {
  const total = Math.min(minuteOf(start) + minutes, MINUTES_IN_DAY - 1);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

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
 */
export const normalizeRefine = (
  parse: QuickAddParse,
  {
    draft,
    referenceDate,
    timeZone,
    utterance,
  }: { draft: RefineDraft; referenceDate: string; timeZone: string; utterance: string },
): RefineResult => {
  const title = meaningfulText(parse.title) ?? draft.title;
  const place = meaningfulText(parse.location);
  const location = place === undefined ? draft.location : placeOf(place, title);

  const modelDate = realDate(parse.date?.trim());
  const date =
    groundDate(modelDate, { phrase: utterance, referenceDate }) ??
    (modelDate !== undefined && mentionsDate(utterance) ? modelDate : draft.date);

  const times = timesOf(utterance, realTime(parse.startTime), draft);
  const length = durationMinutesOf(utterance);
  let isAllDay = draft.isAllDay;
  let startTime = draft.startTime;
  let endTime = draft.endTime;
  let assumedTime = draft.assumedTime === true;
  if (times !== undefined) {
    isAllDay = false;
    startTime = times.startTime;
    // A stated range sets both ends; a moved start keeps the length it had.
    endTime =
      times.endTime ??
      plusMinutes(
        startTime,
        draft.isAllDay ? 60 : Math.max(minuteOf(draft.endTime) - minuteOf(draft.startTime), 15),
      );
    assumedTime = times.assumed;
  } else if (isAllDayPhrase(utterance)) {
    isAllDay = true;
    startTime = '00:00';
    endTime = addHour(startTime);
    assumedTime = false;
  }
  if (length !== undefined && !isAllDay && times?.endTime === undefined) {
    endTime = plusMinutes(startTime, length);
  }
  if (!isAllDay && endTime <= startTime) {
    return { kind: 'rejected', reason: 'That would end after midnight — pick an earlier time.' };
  }

  const fields = {
    calendarKey: 'placeholder:placeholder',
    date,
    endTime,
    isAllDay,
    startTime,
    title,
  };
  const invalid = validateEventDraft(fields, timeZone);
  if (invalid) {
    return { kind: 'rejected', reason: invalid };
  }

  const recurrence = clearsRepeat(utterance)
    ? undefined
    : mentionsRepeat(utterance)
      ? recurrenceFromParse(parse.recurrence, date)
      : draft.recurrence;

  return {
    kind: 'parsed',
    prefill: {
      ...(assumedTime ? { assumedTime } : {}),
      date,
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
  return normalizeRefine(raw as QuickAddParse, { draft, referenceDate, timeZone, utterance });
};
