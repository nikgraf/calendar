import type { RecurrenceFrequency } from '@calendar/core';

/** Repeat chips shared by the event editor and the Reminders form. */
export const REPEAT_OPTIONS: ReadonlyArray<{ label: string; value: RecurrenceFrequency | 'none' }> =
  [
    { label: 'Does not repeat', value: 'none' },
    { label: 'Daily', value: 'daily' },
    { label: 'Weekly', value: 'weekly' },
    { label: 'Monthly', value: 'monthly' },
    { label: 'Yearly', value: 'yearly' },
  ];

export const REPEAT_ENDS_OPTIONS: ReadonlyArray<{
  label: string;
  value: 'after' | 'never' | 'on';
}> = [
  { label: 'Never', value: 'never' },
  { label: 'After', value: 'after' },
  { label: 'On date', value: 'on' },
];

/** The shared input class of the editor dialog. */
export const FIELD_CLASS =
  'w-full rounded-lg border border-neutral-200 bg-white px-3 py-1.5 text-sm';
export const LABEL_CLASS = 'text-xs font-medium text-neutral-500';
