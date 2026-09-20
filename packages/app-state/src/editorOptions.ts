import {
  MONTHLY_ORDINALS,
  type MonthlyOrdinal,
  ORDINAL_NAMES,
  type RecurrenceFrequency,
  type RecurringScope,
  type RsvpResponse,
  WEEKDAY_NAMES,
  WEEKDAYS_MONDAY_FIRST,
  type Weekday,
} from '@calendar/core';
import type { MonthlyMode } from './repeatState.ts';

/**
 * The option tables both editors render as chips or selects. They lived
 * in three copies (desktop taskEditorOptions, desktop EventEditor, iOS
 * editSheetShared) and had already drifted ("Does not repeat" / "None",
 * "This and following" / "This + following"). `label` is the full text,
 * `short` the chip text where width is tight (iOS).
 */
export interface EditorOption<Value extends number | string> {
  readonly label: string;
  readonly short: string;
  readonly value: Value;
}

export const REPEAT_OPTIONS: ReadonlyArray<EditorOption<RecurrenceFrequency | 'none'>> = [
  { label: 'Does not repeat', short: 'None', value: 'none' },
  { label: 'Daily', short: 'Daily', value: 'daily' },
  { label: 'Weekly', short: 'Weekly', value: 'weekly' },
  { label: 'Monthly', short: 'Monthly', value: 'monthly' },
  { label: 'Yearly', short: 'Yearly', value: 'yearly' },
];

export const REPEAT_ENDS_OPTIONS: ReadonlyArray<EditorOption<'after' | 'never' | 'on'>> = [
  { label: 'Never ends', short: 'Never', value: 'never' },
  { label: 'Ends after', short: 'After', value: 'after' },
  { label: 'Ends on date', short: 'On date', value: 'on' },
];

/** Mon-first weekday toggles for weekly rules. */
export const WEEKDAY_OPTIONS: ReadonlyArray<EditorOption<Weekday>> = WEEKDAYS_MONDAY_FIRST.map(
  (weekday) => ({
    label: WEEKDAY_NAMES[weekday].long,
    short: WEEKDAY_NAMES[weekday].short,
    value: weekday,
  }),
);

/** How a monthly rule picks its day; the desktop labels name the anchor's day themselves. */
export const MONTHLY_MODE_OPTIONS: ReadonlyArray<EditorOption<MonthlyMode>> = [
  { label: 'On the day of the month', short: 'Day', value: 'dayOfMonth' },
  { label: 'On a weekday of the month', short: 'Weekday', value: 'weekday' },
];

export const ORDINAL_OPTIONS: ReadonlyArray<EditorOption<MonthlyOrdinal>> = MONTHLY_ORDINALS.map(
  (ordinal) => ({
    label: ORDINAL_NAMES[ordinal],
    short: ORDINAL_NAMES[ordinal],
    value: ordinal,
  }),
);

export const SCOPE_OPTIONS: ReadonlyArray<EditorOption<RecurringScope>> = [
  { label: 'This event', short: 'This event', value: 'instance' },
  { label: 'This and following', short: 'This + following', value: 'following' },
  { label: 'All events', short: 'All events', value: 'series' },
];

export const RSVP_OPTIONS: ReadonlyArray<EditorOption<RsvpResponse>> = [
  { label: 'Accept', short: 'Accept', value: 'accepted' },
  { label: 'Maybe', short: 'Maybe', value: 'tentative' },
  { label: 'Decline', short: 'Decline', value: 'declined' },
];
