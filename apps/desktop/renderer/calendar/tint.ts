import { type EventRecord, eventTint, type EventTint, meetingUrl } from '@calendar/core';
import { useCallback } from 'react';
import { useColorScheme } from '../theme.ts';

/** `eventTint` for the window's current scheme: every calendar-colored block and chip goes through it. */
export const useTint = (): ((hex: string) => EventTint) => {
  const scheme = useColorScheme();
  return useCallback((hex: string) => eventTint(hex, scheme), [scheme]);
};

/** What an event's block or chip conveys beyond its calendar color. */
export interface EventLook {
  /** The user declined: drawn struck through and faded. */
  readonly declined: boolean;
  readonly hasMeeting: boolean;
  readonly repeats: boolean;
  /** Google's "tentative" status: a striped fill. */
  readonly tentative: boolean;
}

export const eventLook = (event: EventRecord): EventLook => ({
  declined: event.attendees?.find((attendee) => attendee.isSelf)?.responseStatus === 'declined',
  hasMeeting: meetingUrl(event) !== undefined,
  repeats: event.recurrence !== undefined || event.recurringEventId !== undefined,
  tentative: event.status === 'tentative',
});

/** The striped fill of a tentative event, over the tint's edge color. */
export const stripes = (edge: string): string =>
  `repeating-linear-gradient(135deg, transparent 0 5px, ${edge}55 5px 7px)`;
