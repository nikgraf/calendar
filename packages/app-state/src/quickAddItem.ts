import type { QuickAddPrefill, QuickAddTaskPrefill } from '@calendar/ai';

/** What a phrase was understood as: the editor fills its form from it. */
export type QuickAddItem =
  | { readonly kind: 'event'; readonly prefill: QuickAddPrefill }
  | { readonly kind: 'task'; readonly prefill: QuickAddTaskPrefill };

const addHour = (time: string): string => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  // Clamp instead of spilling into the next day: the editor works on one date.
  return hour >= 23
    ? '23:59'
    : `${String(hour + 1).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};

/**
 * The same phrase as the other kind of item: a timed event becomes a task
 * due at its start, an all-day one a task on its day; a task becomes a
 * one-hour event at its time, or an all-day event without one. Used when
 * the editor stays on its kind (the user declined the switch, or the
 * parsed kind has nowhere to go).
 */
export const convertQuickAddItem = (
  item: QuickAddItem,
  kind: QuickAddItem['kind'],
): QuickAddItem => {
  if (item.kind === kind) {
    return item;
  }
  if (item.kind === 'event') {
    const { date, isAllDay, startTime, title } = item.prefill;
    return { kind: 'task', prefill: { date, ...(isAllDay ? {} : { time: startTime }), title } };
  }
  const { date, time, title } = item.prefill;
  return {
    kind: 'event',
    prefill: {
      date,
      endTime: addHour(time ?? '00:00'),
      isAllDay: time === undefined,
      startTime: time ?? '00:00',
      title,
    },
  };
};
