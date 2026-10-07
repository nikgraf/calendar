import type { QuickAddPrefill, QuickAddTaskPrefill } from '@calendar/ai';

/** What a phrase was understood as, held for review before anything opens or is written. */
export type QuickAddReview =
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
 * one-hour event at its time, or an all-day event without one. The
 * review's Event/Task toggle.
 */
export const convertQuickAddItem = (
  review: QuickAddReview,
  kind: QuickAddReview['kind'],
): QuickAddReview => {
  if (review.kind === kind) {
    return review;
  }
  if (review.kind === 'event') {
    const { date, isAllDay, startTime, title } = review.prefill;
    return { kind: 'task', prefill: { date, ...(isAllDay ? {} : { time: startTime }), title } };
  }
  const { date, time, title } = review.prefill;
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
