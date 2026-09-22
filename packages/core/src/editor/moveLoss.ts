import { Schema } from 'effect';
import { unsupportedRuleParts } from '../recurrence/structured.ts';
import type { EventRecord, TaskProvider } from '../types.ts';

/**
 * What moving an event to another calendar would drop. A move inside one
 * Google account is a server-side `events.move` and keeps everything;
 * every other move copies the event into the target and deletes the
 * source, which cannot carry guests (re-inviting them from a new event
 * would email everyone, and EventKit cannot invite at all), a Google
 * conference link into another Google calendar, modified occurrences of
 * a series, or rule parts EventKit cannot store.
 */
export const MoveLoss = Schema.Struct({
  /** Guests (rooms excluded) that will not follow the event. */
  attendees: Schema.Number,
  /** Email reminders set on the event; EventKit alarms can only pop up. */
  emailReminders: Schema.Number,
  /** The Google conference link is dropped (a move to Apple keeps it as the event URL). */
  meetingLink: Schema.Boolean,
  /** Occurrences edited or cancelled on their own; the series moves as its rule only. */
  modifiedOccurrences: Schema.Number,
  /** Recurrence parts (e.g. "EXDATE") an Apple calendar cannot store. */
  unsupportedRuleParts: Schema.Array(Schema.String),
});
export type MoveLoss = typeof MoveLoss.Type;

export interface MoveRoute {
  readonly sameAccount: boolean;
  readonly source: TaskProvider;
  readonly target: TaskProvider;
}

/** Google → Google inside one account is a server move; everything else copies. */
export const isServerMove = (route: MoveRoute): boolean =>
  route.sameAccount && route.source === 'google' && route.target === 'google';

const NO_LOSS: MoveLoss = {
  attendees: 0,
  emailReminders: 0,
  meetingLink: false,
  modifiedOccurrences: 0,
  unsupportedRuleParts: [],
};

export const moveLoss = (
  event: Pick<EventRecord, 'attendees' | 'hangoutLink' | 'isAllDay' | 'recurrence' | 'reminders'>,
  route: MoveRoute,
  modifiedOccurrences: number,
): MoveLoss => {
  if (isServerMove(route)) {
    return NO_LOSS;
  }
  if (route.source === 'apple' && route.target === 'apple') {
    // Same EventKit store: the event keeps its identity and detached occurrences.
    return NO_LOSS;
  }
  return {
    attendees: (event.attendees ?? []).filter(
      (attendee) => !attendee.isResource && !attendee.isOrganizer && !attendee.isSelf,
    ).length,
    // Reminders the calendar defaults supply are the calendar's, not the event's.
    emailReminders:
      route.target === 'apple' && event.reminders && !event.reminders.useDefault
        ? event.reminders.overrides.filter((override) => override.method === 'email').length
        : 0,
    meetingLink: route.source === 'google' && route.target === 'google' && !!event.hangoutLink,
    modifiedOccurrences,
    unsupportedRuleParts:
      route.target === 'apple' ? unsupportedRuleParts(event.recurrence, event.isAllDay) : [],
  };
};

export const isLossy = (loss: MoveLoss): boolean =>
  loss.attendees > 0 ||
  loss.emailReminders > 0 ||
  loss.meetingLink ||
  loss.modifiedOccurrences > 0 ||
  loss.unsupportedRuleParts.length > 0;

export const plural = (count: number, one: string, many: string): string =>
  `${count} ${count === 1 ? one : many}`;

export const joinList = (items: ReadonlyArray<string>): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;

/** One sentence for the move confirmation, or null when nothing is lost. */
export const moveLossSummary = (loss: MoveLoss): string | null => {
  const items: Array<string> = [];
  if (loss.attendees > 0) {
    items.push(plural(loss.attendees, 'guest', 'guests'));
  }
  if (loss.meetingLink) {
    items.push('the meeting link');
  }
  if (loss.emailReminders > 0) {
    items.push(plural(loss.emailReminders, 'email reminder', 'email reminders'));
  }
  if (loss.modifiedOccurrences > 0) {
    items.push(plural(loss.modifiedOccurrences, 'modified occurrence', 'modified occurrences'));
  }
  if (loss.unsupportedRuleParts.length > 0) {
    items.push(
      `repeat rules the target calendar cannot store (${loss.unsupportedRuleParts.join(', ')})`,
    );
  }
  return items.length === 0
    ? null
    : `Moving this event to another account drops ${joinList(items)}.`;
};
