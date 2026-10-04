import { Temporal } from '@calendar/core';

/**
 * The value checks every parser shares. The model is trusted only for
 * extraction, so each field it returns is re-checked here before it reaches
 * an editor or a solver.
 */

const TIME = /^(\d{1,2}):(\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Small models fill optional string fields with placeholders instead of
 * omitting them — an observed run wrote "unknown" into location for a
 * phrase that never mentioned one.
 */
const PLACEHOLDERS = new Set(['-', 'n/a', 'na', 'none', 'null', 'tbd', 'unknown', 'unspecified']);

/** Days of dated weekdays given to the model to choose from. */
const CALENDAR_HINT_DAYS = 14;

/** A real calendar date, not merely a date-shaped string ('2026-02-30'). */
export const realDate = (value: string | undefined): string | undefined => {
  if (!value || !DATE.test(value)) {
    return undefined;
  }
  try {
    return Temporal.PlainDate.from(value, { overflow: 'reject' }).toString();
  } catch {
    return undefined;
  }
};

/** `HH:MM` on a 24-hour clock, zero-padded; anything else is dropped. */
export const realTime = (value: string | undefined): string | undefined => {
  const match = value ? TIME.exec(value.trim()) : null;
  if (!match) {
    return undefined;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    return undefined;
  }
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/** Trimmed text that says something, or undefined for blanks and placeholders. */
export const meaningfulText = (value: string | undefined): string | undefined => {
  const text = value?.trim();
  return text && !PLACEHOLDERS.has(text.toLowerCase()) ? text : undefined;
};

/**
 * A dated weekday list the model can look up instead of computing. Small
 * models get relative-date arithmetic wrong often enough to matter: an
 * observed "next Tuesday" landed on a Thursday before this existed.
 */
export const upcomingDays = (referenceDate: string): string =>
  Array.from({ length: CALENDAR_HINT_DAYS }, (_, index) => {
    const date = Temporal.PlainDate.from(referenceDate).add({ days: index });
    const weekday = date.toLocaleString('en-US', { weekday: 'short' });
    return `${weekday} ${date.toString()}${index === 0 ? ' (today)' : ''}`;
  }).join(', ');
