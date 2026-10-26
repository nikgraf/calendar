import {
  addDaysToPlainDate,
  type ByDay,
  foldSearchText,
  monthlyOrdinalOf,
  type RecurrenceFrequency,
  Temporal,
  validateEventDraft,
  type Weekday,
  WEEKDAYS_MONDAY_FIRST,
} from '@calendar/core';
import {
  clearsRepeat,
  groundDate,
  groundTime,
  groundTitle,
  isTodoPhrase,
  namesDays,
  type RepeatSpanUnit,
  saysOnlyWhen,
  statedRepeat,
  statesNoEnd,
  statesUntil,
  trimWhen,
  withoutPlace,
} from './grounding.ts';
import { inviteesOf, titleWithoutInvitees } from './invitees.ts';
import type { QuickAddParse } from './quickAdd.ts';
import { meaningfulText, realDate, realTime } from './shared.ts';

/** Editor prefill: exactly the fields the shared editor model seeds from. */
export interface QuickAddPrefill {
  /**
   * The times came from a meal or part of the day the phrase named, not a
   * clock time it stated: the editor marks them so, until they are set.
   */
  readonly assumedTime?: boolean | undefined;
  readonly date: string;
  /**
   * The day it ends on, when not `date`: only the editor's form sets one
   * (a multi-day or overnight draft); a refinement keeps the span.
   */
  readonly endDate?: string | undefined;
  readonly endTime: string;
  readonly isAllDay: boolean;
  readonly location?: string | undefined;
  /**
   * Recurrence as the editor's own fields, not a built RRULE — the editor
   * shows them and builds the rule itself on save.
   */
  readonly recurrence?:
    | {
        /**
         * The days the phrase or the editor chose: a weekly rule's set
         * ("every weekday", "Mondays and Wednesdays"), a monthly rule's
         * "Nth weekday". A single weekday is the date's, never listed; a
         * refinement keeps the editor's days.
         */
        readonly byDay?: ReadonlyArray<ByDay> | undefined;
        readonly count?: number | undefined;
        readonly freq: RecurrenceFrequency;
        readonly interval?: number | undefined;
        readonly untilDate?: string | undefined;
      }
    | undefined;
  readonly startTime: string;
  readonly title: string;
}

/** A phrase understood as a to-do: what the task editor opens with. */
export interface QuickAddTaskPrefill {
  readonly date: string;
  /** `HH:MM` when the phrase named a time (only a Reminders list keeps it). */
  readonly time?: string;
  readonly title: string;
}

export type QuickAddResult =
  | {
      /** Names or addresses the words invite, as said: the thread looks them up in the contacts. */
      readonly invite?: ReadonlyArray<string> | undefined;
      readonly kind: 'parsed';
      readonly prefill: QuickAddPrefill;
      /** Names or addresses the words take off the guest list (a refinement only). */
      readonly uninvite?: ReadonlyArray<string> | undefined;
    }
  | { readonly kind: 'rejected'; readonly reason: string }
  | { readonly kind: 'task'; readonly prefill: QuickAddTaskPrefill };

const FREQUENCIES = new Set<RecurrenceFrequency>(['daily', 'monthly', 'weekly', 'yearly']);

/** The unit a frequency counts in: "for six weeks" on a weekly rule is six times. */
const UNIT_OF: Readonly<Record<RecurrenceFrequency, RepeatSpanUnit>> = {
  daily: 'days',
  monthly: 'months',
  weekly: 'weeks',
  yearly: 'years',
};
/** Shortest first: a span in a smaller unit than the rule's is the event's length, not the series'. */
const SPAN_UNITS: ReadonlyArray<RepeatSpanUnit> = ['days', 'weeks', 'months', 'years'];

/**
 * A repeat end before the first day reads as next year's: "every Monday
 * until March", said in October, means the coming March, and models
 * answer with this year's. Still before the start a year on, it is a
 * misread and dropped — the editor would refuse it.
 */
const untilOnOrAfter = (until: string | undefined, start: string): string | undefined => {
  if (until === undefined || until >= start) {
    return until;
  }
  const nextYear = Temporal.PlainDate.from(until).add({ years: 1 }).toString();
  return nextYear >= start ? nextYear : undefined;
};

const positiveInt = (value: number | undefined): number | undefined =>
  value !== undefined && Number.isInteger(value) && value >= 1 ? value : undefined;

const modelFreq = (parsed: QuickAddParse['recurrence']): RecurrenceFrequency | undefined =>
  parsed?.freq !== undefined && FREQUENCIES.has(parsed.freq) ? parsed.freq : undefined;

/** The first day on or after `date` that is a `weekday`. */
const nextOn = (date: string, weekday: Weekday): string => {
  const from = Temporal.PlainDate.from(date);
  const target = WEEKDAYS_MONDAY_FIRST.indexOf(weekday) + 1;
  return from.add({ days: (target - from.dayOfWeek + 7) % 7 }).toString();
};

/**
 * Whether a date is the Nth such weekday of its month as BYDAY counts
 * (the 4th may also be the last; `monthlyOrdinalOf` labels it "last"
 * for the picker, the rule means either).
 */
const isNthWeekday = (date: string, ordinal: number): boolean => {
  const day = Temporal.PlainDate.from(date);
  return ordinal === -1 ? day.day > day.daysInMonth - 7 : Math.ceil(day.day / 7) === ordinal;
};

/**
 * The first day a rule with chosen weekdays falls on, on or after `date`:
 * a weekly rule's next listed day, a monthly rule's next "Nth weekday".
 * A start the rule skips is drawn as one more first occurrence
 * (`expand.ts`), which "every weekday" said on a Saturday never means.
 */
export const firstDayOn = (date: string, recurrence: QuickAddPrefill['recurrence']): string => {
  const days = recurrence?.byDay ?? [];
  const [first] = days;
  if (recurrence === undefined || first === undefined) {
    return date;
  }
  if (recurrence.freq === 'weekly') {
    return days.map((day) => nextOn(date, day.weekday)).sort()[0]!;
  }
  if (recurrence.freq === 'monthly' && first.ordinal !== undefined) {
    // Every month has a 1st to 4th and a last of each weekday: six weeks on at most.
    let candidate = nextOn(date, first.weekday);
    for (let week = 0; week < 6; week += 1) {
      if (isNthWeekday(candidate, first.ordinal)) {
        return candidate;
      }
      candidate = addDaysToPlainDate(candidate, 7);
    }
  }
  return date;
};

/** The days of a weekly or monthly rule, as the phrase named them; none where the rule cannot hold them. */
const byDayFor = (
  days: ReadonlyArray<ByDay> | undefined,
  freq: RecurrenceFrequency,
  firstDay: string,
): ReadonlyArray<ByDay> | undefined => {
  if (days === undefined || days.length === 0) {
    return undefined;
  }
  if (freq === 'weekly') {
    return days.some((each) => each.ordinal !== undefined) ? undefined : days;
  }
  const [day, ...more] = days;
  if (freq !== 'monthly' || day === undefined || more.length > 0) {
    return undefined;
  }
  // "every month on Wednesday": the Nth Wednesday the first one is.
  return [
    {
      ordinal: day.ordinal ?? monthlyOrdinalOf(nextOn(firstDay, day.weekday)),
      weekday: day.weekday,
    },
  ];
};

/** The last day of a span that starts on `firstDay` ("for two weeks" from a Monday ends the second Sunday). */
const lastDayOf = (firstDay: string, span: { amount: number; unit: RepeatSpanUnit }): string =>
  Temporal.PlainDate.from(firstDay)
    .add({ [span.unit]: span.amount })
    .subtract({ days: 1 })
    .toString();

/** The end the model read, as the coming one ("until March" said in October). */
const repeatEndFromParse = (
  parsed: QuickAddParse['recurrence'],
  firstDay: string,
): string | undefined => untilOnOrAfter(realDate(parsed?.untilDate), firstDay);

type Recurrence = NonNullable<QuickAddPrefill['recurrence']>;

/**
 * The repeat for the editor, or none. Given the phrase, the words decide
 * (`statedRepeat`): a phrase that names no repeat has none, whatever the
 * model attached ("next Tuesday" came back weekly, once); one that does
 * gives the frequency, the gap, the days, a count or a span, and the
 * model's frequency stands only where the words name a repeat without
 * saying which ("make it recurring"). The model's count and gap are never
 * kept — it answered "every Monday" with once, "every weekday" with five
 * times and "every two weeks" with a gap of fourteen — and its end only
 * behind an until word, read as the coming one ("until March" in
 * October). Without a phrase (capture) the model's rule stands as
 * validated, "repeats once" being none.
 *
 * Over a `current` rule (a refinement of a draft that repeats) the words
 * change what they say and leave the rest: the kind, gap and days stay
 * while the words name none ("10 times", "for six weeks", "until March"
 * on their own), the editor's days stay while the kind does and the
 * words name no day, and the end or count stays while the words give
 * none, and goes when they say there is none ("forever"). "No repeat"
 * clears it, and so does an end on the first day ("until 22 August" said
 * of the 22nd): nothing repeats.
 */
export const recurrenceFromParse = (
  parsed: QuickAddParse['recurrence'],
  firstDay: string,
  phrase?: string,
  current?: QuickAddPrefill['recurrence'],
): QuickAddPrefill['recurrence'] => {
  if (phrase === undefined) {
    const freq = parsed?.count === 1 ? undefined : modelFreq(parsed);
    if (freq === undefined) {
      return undefined;
    }
    const count = positiveInt(parsed?.count);
    const interval = positiveInt(parsed?.interval);
    const untilDate = untilOnOrAfter(realDate(parsed?.untilDate), firstDay);
    return {
      ...(count === undefined ? {} : { count }),
      freq,
      ...(interval === undefined || interval < 2 ? {} : { interval }),
      ...(untilDate === undefined ? {} : { untilDate }),
    };
  }
  if (clearsRepeat(phrase)) {
    return undefined;
  }
  const stated = statedRepeat(phrase, { ofRepeat: current !== undefined });
  const saysUntil = statesUntil(phrase);
  if (stated === undefined) {
    // Nothing said of a repeat: none, or the draft's as it is — with an
    // end the words alone give it ("until March").
    const end =
      current === undefined || !saysUntil ? undefined : repeatEndFromParse(parsed, firstDay);
    if (end === undefined) {
      return current;
    }
    if (end === firstDay) {
      return undefined;
    }
    const { count: _count, ...rest } = current!;
    return { ...rest, untilDate: end };
  }
  const sameKind =
    current !== undefined && (stated.freq === undefined || stated.freq === current.freq);
  const freq = stated.freq ?? current?.freq ?? modelFreq(parsed);
  if (freq === undefined) {
    return undefined;
  }
  const interval =
    stated.interval ?? (stated.freq === undefined && sameKind ? current!.interval : undefined);
  const byDay =
    byDayFor(stated.byDay, freq, firstDay) ??
    (sameKind && stated.byDay === undefined && !namesDays(phrase) ? current!.byDay : undefined);
  // "for a week" on a yearly rule is how long the event lasts, not the
  // series — but "every weekday for three days" is three standups.
  const span =
    stated.runsFor !== undefined &&
    (SPAN_UNITS.indexOf(stated.runsFor.unit) >= SPAN_UNITS.indexOf(UNIT_OF[freq]) ||
      (freq === 'weekly' && (byDay ?? []).length > 1))
      ? stated.runsFor
      : undefined;
  // "every Monday for six weeks" is six times; "every weekday for six
  // weeks" is thirty, so a rule on several days ends on the span's last
  // day instead, counted from the day it starts on — as does a monthly
  // or yearly one, whose periods a date can skip (the 31st, Feb 29).
  const count =
    stated.count ??
    (span !== undefined &&
    span.unit === UNIT_OF[freq] &&
    (freq === 'daily' || freq === 'weekly') &&
    interval === undefined &&
    (byDay ?? []).length <= 1
      ? span.amount
      : undefined);
  const untilDate =
    count !== undefined
      ? undefined
      : span !== undefined
        ? lastDayOf(firstDayOn(firstDay, { byDay, freq }), span)
        : saysUntil
          ? repeatEndFromParse(parsed, firstDay)
          : undefined;
  if (untilDate !== undefined && untilDate <= firstDay) {
    return undefined;
  }
  // The draft's own end or count stays while the words give none, and
  // goes when they say there is none ("forever").
  const kept: Partial<Recurrence> =
    current !== undefined &&
    stated.count === undefined &&
    span === undefined &&
    !saysUntil &&
    !statesNoEnd(phrase)
      ? {
          ...(current.count === undefined ? {} : { count: current.count }),
          ...(current.untilDate === undefined ? {} : { untilDate: current.untilDate }),
        }
      : {};
  return {
    ...kept,
    ...(byDay === undefined ? {} : { byDay }),
    ...(count === undefined ? {} : { count }),
    freq,
    ...(interval === undefined || interval < 2 ? {} : { interval }),
    ...(untilDate === undefined ? {} : { untilDate }),
  };
};

/**
 * A draft placed on its rule's first day: the date moved onto the days
 * the words chose. A rule that ends before that day has nothing to
 * repeat ("every weekday until tomorrow", said on a Saturday): no
 * repeat, the date as it was.
 */
export const startOnRule = (
  date: string,
  recurrence: QuickAddPrefill['recurrence'],
): { readonly date: string; readonly recurrence: QuickAddPrefill['recurrence'] } => {
  const start = firstDayOn(date, recurrence);
  return recurrence?.untilDate !== undefined && recurrence.untilDate < start
    ? { date, recurrence: undefined }
    : { date: start, recurrence };
};

/** One hour on, clamped to the day: the editor works on one date. */
export const addHour = (time: string): string => {
  const [hour, minute] = time.split(':').map(Number) as [number, number];
  return hour >= 23
    ? '23:59'
    : `${String(hour + 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/**
 * The cue that made the phrase a to-do, when the model left it in the
 * title ("remind me to call the bank" came back whole): the title is the
 * thing to do.
 */
const TODO_CUE_PREFIX =
  /^(?:remind me(?:\s+(?:today|tonight|tomorrow|(?:on|next|this)\s+\w+|(?:mon|tues|wednes|thurs|fri|satur|sun)days?|in the (?:morning|afternoon|evening)|at\s+\d{1,2}(?::\d{2})?\s*(?:[ap]m)?|\d{1,2}(?::\d{2})?\s*[ap]m)){0,3}\s+to|reminder:?|to-?do:?|don'?t forget to|i (?:need|have) to|i must|ich muss|nicht vergessen:?)\s+/i;

/**
 * The first letter upper-cased when the first word is all lower case
 * ("lunch with tom" is "Lunch with tom"); "iPhone repair" stays as typed.
 */
const capitalized = (title: string): string =>
  /\p{Lu}/u.test(/^\S*/u.exec(title)![0])
    ? title
    : title.replace(/^\p{Ll}/u, (letter) => letter.toLocaleUpperCase());

/** Lower-case, accent-free text with straight apostrophes and "ss" for ß. */
const fold = (text: string): string =>
  foldSearchText(text)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

/**
 * The words that put a place after them ("at Figlmüller", "in Vienna",
 * "bei Anna", "im Café Central"), an article allowed between.
 */
const PLACE_CUE =
  /(?:^|[^\p{L}])(?:at|in|@|bei|beim|im|am|ins|zum|zur|in der|in dem|an der|auf der|auf dem|vor dem|vor der|chez)\s+(?:(?:the|a|an|der|die|das|dem|den|ein|eine|einem|einer)\s+)?$/u;

/** Company, not a place: a name right after "with" ("lunch with tom", "Essen mit Anna"). */
const COMPANY = /(?:^|[^\p{L}])(?:with|w\/|mit|and|und|&)\s+$/u;

/**
 * The place the model extracted, held against the phrase: it must be in
 * the words (the real model made up "Bob's house" and "unknown"), never
 * only a when ("tomorrow") or the company the words name ("tom" for
 * "tomorrow lunch with tom"), and where it is also part of the title ("Dentist" for "Dentist tomorrow
 * at 9", "Board review" for "Board review Thursday 2pm") it counts only
 * after a place cue in the phrase ("Meeting at the office"). The title
 * over again is never a place. Without a phrase (capture) the model's
 * place stands as it is, as it always did — a reservation titled and
 * placed "Figlmüller" keeps its place.
 */
export const placeOf = (
  location: string | undefined,
  title: string,
  phrase?: string,
): string | undefined => {
  // Capture (no phrase) keeps the model's place as it is, as it always did.
  if (location === undefined || phrase === undefined) {
    return location;
  }
  if (fold(location) === fold(title)) {
    return undefined;
  }
  const words = fold(phrase);
  const place = fold(location);
  const at = words.indexOf(place);
  if (at === -1 || saysOnlyWhen(location)) {
    return undefined;
  }
  // Where the place stands as words of its own ("tom", not the start of "tomorrow").
  const occurrences: Array<number> = [];
  for (let from = at; from !== -1; from = words.indexOf(place, from + 1)) {
    if (
      !/[\p{L}\p{N}]/u.test(words[from - 1] ?? ' ') &&
      !/[\p{L}\p{N}]/u.test(words[from + place.length] ?? ' ')
    ) {
      occurrences.push(from);
    }
  }
  if (occurrences.length > 0 && occurrences.every((from) => COMPANY.test(words.slice(0, from)))) {
    return undefined;
  }
  if (!fold(title).includes(place)) {
    return location;
  }
  // Any occurrence after a cue will do ("at 1 at Figlmüller" has two "at"s).
  return occurrences.some((from) => PLACE_CUE.test(words.slice(0, from))) ? location : undefined;
};

/**
 * Turns raw model output into a prefill the editor can open, or rejects it.
 *
 * The model is trusted only for extraction; every value is re-checked here,
 * because a schema-shaped answer can still be nonsense (23:70, a title of
 * whitespace, an end before its start). Given the phrase, the answer is
 * also held against it (`grounding.ts`): the start must be a clock time
 * the phrase states or the default of a meal or part of the day it names,
 * else the event is all day; the end comes only from a stated range; a
 * weekday the phrase names is where the date lands; the phrase is a
 * to-do only on a to-do cue; only the people it says to invite are
 * invited (`invitees.ts`), the invitation kept out of the title; and the
 * title is the phrase's own words, without the when at its ends. Capture
 * has no one phrase per item, so it passes none and the model's times
 * stand as validated.
 */
export const normalizeQuickAdd = (
  parse: QuickAddParse,
  {
    fallbackDate,
    people,
    phrase,
    referenceDate,
    timeZone,
  }: {
    /**
     * Used when the phrase named no date — the day the user is looking at,
     * which is not necessarily today. `referenceDate` stays the anchor for
     * relative phrases like "tomorrow".
     */
    fallbackDate?: string | undefined;
    /** The names the model read as invited (`readPeople`), held against the phrase. */
    people?: ReadonlyArray<string> | undefined;
    /** The words the answer came from; when given, the answer is checked against them. */
    phrase?: string | undefined;
    referenceDate: string;
    timeZone: string;
  },
): QuickAddResult => {
  const todo = phrase !== undefined && isTodoPhrase(phrase);
  // Who the words invite, held against them. A to-do invites no one ("remind
  // me to invite Tom" is the thing to do); capture reads no one.
  const { invite } = phrase === undefined || todo ? { invite: [] } : inviteesOf(people, phrase);
  const said = meaningfulText(parse.title);
  // Only the phrase's words, without the invitation, the when at its ends
  // and a place it leads into (`grounding.ts`). Capture has no phrase: the
  // model's title stands.
  const named =
    said === undefined
      ? undefined
      : titleWithoutInvitees(phrase === undefined ? said : groundTitle(said, phrase), invite);
  const kept =
    named && phrase !== undefined ? trimWhen(named, meaningfulText(parse.location)) : named;
  // The place leaves an event's title only when its field keeps it; a
  // to-do has no place field.
  const placeless =
    kept && phrase !== undefined && !todo
      ? trimWhen(withoutPlace(kept, meaningfulText(parse.location)), meaningfulText(parse.location))
      : kept;
  const placed =
    placeless !== kept && placeOf(meaningfulText(parse.location), placeless ?? '', phrase)
      ? placeless
      : kept;
  const title = placed && phrase !== undefined ? capitalized(placed) : placed;
  if (!title) {
    return { kind: 'rejected', reason: 'No event title was recognised.' };
  }

  const modelDate = realDate(parse.date?.trim());
  const groundedDate =
    phrase === undefined ? undefined : groundDate(modelDate, { phrase, referenceDate });
  const resolvedDate = groundedDate ?? modelDate ?? realDate(fallbackDate) ?? referenceDate;
  if (!realDate(resolvedDate)) {
    return { kind: 'rejected', reason: 'That date could not be understood.' };
  }

  const modelStart = realTime(parse.startTime);
  const times =
    phrase === undefined
      ? { endTime: realTime(parse.endTime), source: 'model' as const, startTime: modelStart }
      : groundTime(modelStart, phrase);
  const { startTime } = times;
  if (todo) {
    // A to-do: its day, and its time when one was said. No end, no repeat.
    return {
      kind: 'task',
      prefill: {
        date: resolvedDate,
        ...(startTime ? { time: startTime } : {}),
        title: capitalized(title.replace(TODO_CUE_PREFIX, '') || title),
      },
    };
  }
  // No usable time at all means the phrase described a whole day. Without
  // a phrase the model may also say so outright.
  const isAllDay = !startTime || (phrase === undefined && parse.isAllDay === true);
  const resolvedStart = isAllDay ? '00:00' : startTime!;
  // A missing or backwards end becomes a one-hour event rather than an error:
  // "lunch at 1" is a complete thought.
  const resolvedEnd =
    !isAllDay && times.endTime && times.endTime > resolvedStart
      ? times.endTime
      : addHour(resolvedStart);
  if (!isAllDay && resolvedEnd <= resolvedStart) {
    // Only reachable in the final minute of the day: the editor puts start
    // and end on one date, so nothing after 23:59 can be expressed.
    return {
      kind: 'rejected',
      reason: 'That would end after midnight — pick an earlier time.',
    };
  }

  const fields = {
    calendarKey: 'placeholder:placeholder',
    date: resolvedDate,
    endTime: resolvedEnd,
    isAllDay,
    startTime: resolvedStart,
    title,
  };
  const invalid = validateEventDraft(fields, timeZone);
  if (invalid) {
    return { kind: 'rejected', reason: invalid };
  }

  // Capture passes no phrase and keeps its locations as before.
  const location = placeOf(meaningfulText(parse.location), title, phrase);
  // The repeat the words state, and the draft on the first of its days
  // ("every weekday" typed on a Saturday starts on Monday).
  const { date, recurrence } = startOnRule(
    resolvedDate,
    recurrenceFromParse(parse.recurrence, resolvedDate, phrase),
  );

  return {
    ...(invite.length > 0 ? { invite } : {}),
    kind: 'parsed',
    prefill: {
      ...(times.source === 'period' ? { assumedTime: true } : {}),
      date,
      endTime: resolvedEnd,
      isAllDay,
      ...(location ? { location } : {}),
      ...(recurrence ? { recurrence } : {}),
      startTime: resolvedStart,
      title,
    },
  };
};
