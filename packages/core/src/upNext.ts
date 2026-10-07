import { meetingUrl } from './meeting.ts';
import type { EventRecord } from './types.ts';

/** Twelve hours: an "Up next" card does not announce tomorrow morning tonight. */
export const UP_NEXT_HORIZON_MS = 12 * 60 * 60 * 1000;

export interface UpNext {
  readonly event: EventRecord;
  /** The meeting link to join, when the event has one. */
  readonly joinUrl: string | undefined;
  /** Negative while the event is under way. */
  readonly startsInMs: number;
}

/**
 * The event to show as "up next": the earliest timed event that has not
 * ended, starts within the horizon, is not cancelled and was not declined
 * by the user. An event under way counts — its Join button is the one
 * that matters most. All-day events are not appointments and stay out.
 */
export const upNext = (
  events: ReadonlyArray<EventRecord>,
  nowMs: number,
  horizonMs: number = UP_NEXT_HORIZON_MS,
): UpNext | undefined => {
  const candidates = events
    .filter(
      (event) =>
        !event.isAllDay &&
        event.status !== 'cancelled' &&
        event.endUtc > nowMs &&
        event.startUtc < nowMs + horizonMs &&
        event.attendees?.find((attendee) => attendee.isSelf)?.responseStatus !== 'declined',
    )
    .sort((a, b) => a.startUtc - b.startUtc || a.endUtc - b.endUtc);
  const event = candidates[0];
  return event
    ? { event, joinUrl: meetingUrl(event) ?? undefined, startsInMs: event.startUtc - nowMs }
    : undefined;
};
