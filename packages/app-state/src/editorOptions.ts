import type { RecurrenceFrequency, RecurringScope, RsvpResponse } from '@calendar/core';

/**
 * The option tables both editors render as chips or selects. They lived
 * in three copies (desktop taskEditorOptions, desktop EventEditor, iOS
 * editSheetShared) and had already drifted ("Does not repeat" / "None",
 * "This and following" / "This + following"). `label` is the full text,
 * `short` the chip text where width is tight (iOS).
 */
export interface EditorOption<Value extends string> {
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
