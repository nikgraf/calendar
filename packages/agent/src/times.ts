import {
  addDaysToPlainDate,
  daysBetweenPlainDates,
  isValidTimeZone,
  plainDateToUtcMs,
  Temporal,
  toZonedDateTime,
} from '@calendar/core';

const HOUR_MS = 60 * 60 * 1000;

export type Result<A> =
  | { readonly message: string; readonly ok: false }
  | { readonly ok: true; readonly value: A };

const fail = (message: string): { readonly message: string; readonly ok: false } => ({
  message,
  ok: false,
});

/** 'YYYY-MM-DD' naming a real calendar day. */
export const isIsoDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString() === value;
  } catch {
    return false;
  }
};

/**
 * An agent's date-time as an instant. With an offset or `Z` it is exact;
 * without one ("2026-10-01T14:00", or a bare date for midnight) it is the
 * wall clock in `timeZone`.
 */
export const parseDateTime = (value: string, timeZone: string): number | undefined => {
  try {
    return Temporal.Instant.from(value).epochMilliseconds;
  } catch {
    // No offset: fall through to the wall-clock reading.
  }
  try {
    return Temporal.PlainDateTime.from(value).toZonedDateTime(timeZone).toInstant()
      .epochMilliseconds;
  } catch {
    return undefined;
  }
};

/** "2026-10-01T14:00:00+02:00" — the instant as the given zone's wall clock. */
export const formatDateTime = (epochMs: number, timeZone: string): string =>
  toZonedDateTime(epochMs, timeZone).toString({
    smallestUnit: 'second',
    timeZoneName: 'never',
  });

/** What agents send for an event's time: a timed pair or an all-day date range. */
export interface TimeInput {
  readonly end?: string | undefined;
  /** Last day of an all-day event, inclusive. */
  readonly endDate?: string | undefined;
  readonly start?: string | undefined;
  /** First day of an all-day event. */
  readonly startDate?: string | undefined;
  readonly timeZone?: string | undefined;
}

export type EventTimes =
  | {
      /** Exclusive, as stored. */
      readonly endDate: string;
      readonly endUtc: number;
      readonly isAllDay: true;
      readonly startDate: string;
      readonly startUtc: number;
    }
  | {
      readonly endUtc: number;
      readonly isAllDay: false;
      readonly startTimeZone: string;
      readonly startUtc: number;
    };

const allDayTimes = (startDate: string, lastDate: string): Result<EventTimes> => {
  if (!isIsoDate(startDate) || !isIsoDate(lastDate)) {
    return fail('startDate and endDate must be real dates in YYYY-MM-DD form.');
  }
  if (daysBetweenPlainDates(startDate, lastDate) < 0) {
    return fail('endDate must not be before startDate.');
  }
  const endDate = addDaysToPlainDate(lastDate, 1);
  return {
    ok: true,
    value: {
      endDate,
      endUtc: plainDateToUtcMs(endDate),
      isAllDay: true,
      startDate,
      startUtc: plainDateToUtcMs(startDate),
    },
  };
};

const zoneOf = (input: TimeInput, fallback: string): Result<string> => {
  if (input.timeZone === undefined) {
    return { ok: true, value: fallback };
  }
  return isValidTimeZone(input.timeZone)
    ? { ok: true, value: input.timeZone }
    : fail(`Unknown time zone "${input.timeZone}"; use an IANA id such as Europe/Vienna.`);
};

const MIXED = 'Send either start/end (a timed event) or startDate/endDate (all-day), not both.';

/** Times for a new event. A timed event without `end` lasts an hour. */
export const createTimes = (input: TimeInput, defaultZone: string): Result<EventTimes> => {
  const wantsAllDay = input.startDate !== undefined || input.endDate !== undefined;
  const wantsTimed = input.start !== undefined || input.end !== undefined;
  if (wantsAllDay && wantsTimed) {
    return fail(MIXED);
  }
  if (wantsAllDay) {
    if (input.startDate === undefined) {
      return fail('An all-day event needs startDate.');
    }
    return allDayTimes(input.startDate, input.endDate ?? input.startDate);
  }
  if (input.start === undefined) {
    return fail('An event needs start (timed) or startDate (all-day).');
  }
  const zone = zoneOf(input, defaultZone);
  if (!zone.ok) {
    return zone;
  }
  const startUtc = parseDateTime(input.start, zone.value);
  if (startUtc === undefined) {
    return fail(`start "${input.start}" is not an ISO 8601 date-time.`);
  }
  const endUtc =
    input.end === undefined ? startUtc + HOUR_MS : parseDateTime(input.end, zone.value);
  if (endUtc === undefined) {
    return fail(`end "${String(input.end)}" is not an ISO 8601 date-time.`);
  }
  if (endUtc <= startUtc) {
    return fail('end must be after start.');
  }
  return { ok: true, value: { endUtc, isAllDay: false, startTimeZone: zone.value, startUtc } };
};

/** The times an edit starts from: the event's own, or an occurrence's slot. */
export interface ExistingTimes {
  /** Exclusive, as stored (all-day only). */
  readonly endDate?: string | undefined;
  readonly endUtc: number;
  readonly isAllDay: boolean;
  readonly startDate?: string | undefined;
  readonly startTimeZone?: string | undefined;
  readonly startUtc: number;
}

/**
 * Times for an edit, or `undefined` when the edit leaves them alone. A
 * moved start keeps the duration; a lone end keeps the start.
 */
export const updateTimes = (
  input: TimeInput,
  existing: ExistingTimes,
  defaultZone: string,
): Result<EventTimes | undefined> => {
  const wantsAllDay = input.startDate !== undefined || input.endDate !== undefined;
  const wantsTimed = input.start !== undefined || input.end !== undefined;
  if (wantsAllDay && wantsTimed) {
    return fail(MIXED);
  }
  if (!wantsAllDay && !wantsTimed) {
    return { ok: true, value: undefined };
  }
  if (wantsAllDay) {
    const currentStart = existing.isAllDay ? existing.startDate : undefined;
    const startDate = input.startDate ?? currentStart;
    if (startDate === undefined) {
      return fail('Making a timed event all-day needs startDate.');
    }
    if (input.endDate !== undefined) {
      return allDayTimes(startDate, input.endDate);
    }
    // A moved start keeps the span (stored end is exclusive, so span - 1 more days).
    const span =
      existing.isAllDay && currentStart !== undefined && existing.endDate !== undefined
        ? Math.max(1, daysBetweenPlainDates(currentStart, existing.endDate))
        : 1;
    return isIsoDate(startDate)
      ? allDayTimes(startDate, addDaysToPlainDate(startDate, span - 1))
      : fail('startDate must be a real date in YYYY-MM-DD form.');
  }
  const zone = zoneOf(input, existing.startTimeZone ?? defaultZone);
  if (!zone.ok) {
    return zone;
  }
  const currentStart = existing.isAllDay ? undefined : existing.startUtc;
  const startUtc =
    input.start === undefined ? currentStart : parseDateTime(input.start, zone.value);
  if (startUtc === undefined) {
    return fail(
      input.start === undefined
        ? 'Making an all-day event timed needs start.'
        : `start "${input.start}" is not an ISO 8601 date-time.`,
    );
  }
  const duration = existing.isAllDay ? HOUR_MS : existing.endUtc - existing.startUtc;
  const endUtc =
    input.end === undefined ? startUtc + duration : parseDateTime(input.end, zone.value);
  if (endUtc === undefined) {
    return fail(`end "${String(input.end)}" is not an ISO 8601 date-time.`);
  }
  if (endUtc <= startUtc) {
    return fail('end must be after start.');
  }
  return { ok: true, value: { endUtc, isAllDay: false, startTimeZone: zone.value, startUtc } };
};
